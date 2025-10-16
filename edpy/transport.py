import os
import logging
import asyncio
import aiohttp

from collections import defaultdict
from typing import TYPE_CHECKING, Any, Dict, Optional

from .errors import AuthenticationError, RequestError
from .events import (ThreadNewEvent, ThreadUpdateEvent, ThreadDeleteEvent, CommentNewEvent,
                     CommentUpdateEvent, CommentDeleteEvent, CourseCountEvent)
from .models.comment import Comment
from .models.thread import Thread

if TYPE_CHECKING:
    from .client import EdClient

_log = logging.getLogger('edpy.transport')

API_HOST = 'us.edstem.org'
STATIC_FILE_BASE_URL = 'https://static.us.edusercontent.com/files/'

CLOSE_TYPES = (
    aiohttp.WSMsgType.CLOSE,
    aiohttp.WSMsgType.CLOSING,
    aiohttp.WSMsgType.CLOSED
)


class Transport:
    """The class responsible for dealing with connections to Ed client."""

    def __init__(self, client: 'EdClient', ed_token: str) -> None:

        self.client = client
        self.ed_token = ed_token or os.getenv('ED_API_TOKEN')

        self._ws = None
        self._ws_closed = True

        self._session = aiohttp.ClientSession()
        
        self._message_id = 0
        self._message_queue: list[str] = []
        self._message_sent = defaultdict(dict)

    @property
    def ws_connected(self):
        return self._ws is not None and not self._ws.closed

    """
    async def close(self):
        if not self._ws:
            return
        
        await self._ws.close(code=aiohttp.WSCloseCode.OK)
        self._ws = None
        self._ws_closed = True
    """

    async def _request(
        self,
        method: str,
        endpoint: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
        data: Any = None,
        headers: Optional[Dict[str, str]] = None,
        to=None,
        return_json: bool = True,
    ):

        if not self.ed_token:
            raise RequestError('Ed API token is not provided and cannot be loaded from environment')

        request_headers: Dict[str, str] = {'Authorization': self.ed_token}
        if headers:
            request_headers.update(headers)

        url = 'https://{}{}'.format(API_HOST, endpoint)
        _log.debug('Sending request to Ed server: method=%s endpoint=%s', method, endpoint)

        try:
            async with self._session.request(
                method=method,
                url=url,
                headers=request_headers,
                params=params,
                json=json,
                data=data,
            ) as res:

                _log.debug('Received response from server: status_code=%s reason=%s', res.status, res.reason)

                if res.status in (400, 401):
                    raise AuthenticationError('Invalid Ed API token.')
                if res.status == 403:
                    raise RequestError('Missing permission')
                if res.status == 404:
                    raise RequestError('Invalid API endpoint.')
                if res.status >= 400:
                    payload = await res.text()
                    raise RequestError(
                        f'Request to {endpoint} failed with status {res.status}: {payload}'
                    )

                if not return_json:
                    await res.read()
                    return None

                if to is str:
                    return await res.text()

                if res.content_length == 0:
                    return None

                content_type = res.headers.get('Content-Type', '')
                if 'json' not in content_type:
                    text = await res.text()
                    raise RequestError(
                        f'Unexpected response content-type {content_type or "unknown"}: {text}'
                    )

                payload = await res.json()
                return payload if to is None else to.from_dict(payload)

        except aiohttp.ClientError as error:
            raise RequestError(f'Failed to communicate with Ed API: {error}') from error

    async def upload_file(self, filename: str, file: bytes, content_type: str) -> str:
        form = aiohttp.FormData()
        form.add_field('attachment', file, filename=filename, content_type=content_type)
        response = await self._request('POST', '/api/files', data=form)
        file_id = response['file']['id']
        return f'{STATIC_FILE_BASE_URL}{file_id}'

    async def _connect(self):

        attempt = 0
        self._ws_closed = False
        while not self.ws_connected and not self._ws_closed:
            attempt += 1
            try:
                self._ws = await self._session.ws_connect(
                    url='wss://{}/api/stream'.format(API_HOST),
                    headers={'Authorization': self.ed_token},
                    heartbeat=60)
            except aiohttp.WSServerHandshakeError as ce:
                if isinstance(ce, aiohttp.WSServerHandshakeError):
                    if ce.status == 401:
                        _log.warning('Authentication failed.')
                        if attempt == 10:
                            _log.error('Failed due to unkwown reason.')
                            raise ce
                    elif ce.status == 503:  # may happen at times
                        pass
                else:
                    _log.warning('Failed to connect to websocket with status code {} and\
                        error message "{}".Retrying...'.format(ce.status, ce.message))

                backoff = 5
                await asyncio.sleep(backoff)
            else:
                _log.info('Connection to websocket established.')
                attempt = 0

                if self._message_queue:
                    for message in self._message_queue:
                        await self._send(message)
                    self._message_queue.clear()

                await self._listen()

    async def _send(self, data: dict):

        data['id'] = self._message_id = self._message_id + 1
        self._message_sent[self._message_id] = data
        
        if not self.ws_connected:
            _log.debug('WebSocket not ready; queued outgoing payload.')
            self._message_queue.append(data)
            return
        
        _log.debug('Sending payload %s', str(data))
        await self._ws.send_json(data)

    async def _listen(self):
        """ Listens for websocket messages. """
        close_code = None
        
        async for msg in self._ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                await self._handle_message(msg.json())
            elif msg.type == aiohttp.WSMsgType.ERROR:
                _log.error('Websocket connection closed with exception %s', self._ws.exception())
                close_code = aiohttp.WSCloseCode.INTERNAL_ERROR
            elif msg.type in CLOSE_TYPES:
                _log.info('Websocket connection closed with [%d] %s', msg.data, msg.extra)
                close_code = msg.data
                break

        close_code = close_code or self._ws.close_code
        _log.warning('WebSocket disconnected with the following: code=%s', close_code)
        if self._ws:
            await self._ws.close(code=close_code or aiohttp.WSCloseCode.OK)
            self._ws = None
        self._ws_closed = True

    async def _handle_message(self, message: dict):
        
        event_type, data = message['type'], message.get('data')
        event = None

        if event_type in ('chat.init', 'course.subscribe'):
            if event_type == 'course.subscribe':
                sent_msg = self._message_sent[message['id']]
                _log.info(f'Course {sent_msg["oid"]} subscribed.')
            return
        
        if event_type == 'thread.new':
            data = data.get('thread')
            thread = Thread(data, **data)
            event = ThreadNewEvent(thread)
            _log.debug('Event: %s - Payload: %s', event_type, data)

        elif event_type == 'thread.update':
            data = data.get('thread')
            thread = Thread(data, **data)
            event = ThreadUpdateEvent(thread)
            # _log.debug('Event: %s - Payload: %s', event_type, data)

        elif event_type == 'thread.delete': # only id is nontrivial
            thread = Thread(data, id=data.get('thread_id'))     
            event = ThreadDeleteEvent(thread)
            _log.debug('Event: %s - Payload: %s', event_type, data)

        elif event_type == 'comment.new':
            data = data.get('comment')
            comment = Comment(data, **data)
            event = CommentNewEvent(comment)
            _log.debug('Event: %s - Payload: %s', event_type, data)

        elif event_type == 'comment.update':
            data = data.get('comment')
            comment = Comment(data, **data)
            event = CommentUpdateEvent(comment)
            _log.debug('Event: %s - Payload: %s', event_type, data)

        elif event_type == 'comment.delete': # only id and thread_id are nontrivial
            comment = Comment(data, id=data.get('comment_id'), thread_id=data.get('thread_id'))
            event = CommentDeleteEvent(comment)
            _log.debug('Event: %s - Payload: %s', event_type, data)

        elif event_type == 'course.count':
            event = CourseCountEvent(data.get('id'), data.get('count'))
            # _log.debug('Event: %s - Payload: %s', event_type, data)

        else:
            _log.warning('Uknown event. Event: %s - Payload: %s', event_type, data)
        
        await self.client._dispatch_event(event)
