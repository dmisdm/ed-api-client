import asyncio
import logging
import typing as t
from collections import defaultdict
from inspect import getmembers, ismethod

from .errors import RequestError
from .models.comment import Comment
from .models.course import Course
from .models.thread import Thread
from .models.user import CourseUser, CourseUserWithEmail
from .models.endpoints.threads import GetThreadType, ListThreadsType
from .transport import Transport
from .types import EditThreadParams, PostThreadParams

_log = logging.getLogger('edpy.client')


def _build_comment_tree(comment: dict) -> Comment:
    comment_payload = dict(comment)
    child_comments = comment_payload.pop('comments', []) or []
    parsed_children = [_build_comment_tree(child) for child in child_comments]
    return Comment(comment, comments=parsed_children, **comment_payload)


def _build_thread(thread: dict) -> Thread:
    thread_payload = dict(thread)
    answers = thread_payload.pop('answers', []) or []
    comments = thread_payload.pop('comments', []) or []
    parsed_answers = [_build_comment_tree(answer) for answer in answers]
    parsed_comments = [_build_comment_tree(comment) for comment in comments]
    return Thread(thread, answers=parsed_answers, comments=parsed_comments, **thread_payload)

def _ensure_login(func):
    """
    Decorator to ensure valid ed API key before calling the methods.
    """

    async def login_wrapper(self, *args, **kwargs):
        if not self.logged_in:
            await self._login()
        return await func(self, *args, **kwargs)

    return login_wrapper

class EdClient():

    def __init__(self, ed_token: str = None) -> None:

        self._event_hooks = defaultdict(list)
        self._transport = Transport(self, ed_token)
        
        self.logged_in = False
        self.is_subscribed = False

    async def _login(self):

        res = await self._transport._request('GET', '/api/user')
        user = res.get('user')
        _log.info('Logged in as {} ({})'.format(user['name'], user['email']))
        self.logged_in = True

    @_ensure_login
    async def subscribe(self, course_ids: t.Optional[t.Union[int, t.List]] = None):
        
        # if no course id provided all accessible courses will be subscribed
        course_ids = course_ids or [course.id for course in await self.get_courses()]
        course_ids = course_ids if isinstance(course_ids, t.Iterable) else [course_ids]

        self.is_subscribed = True
        while self.is_subscribed:
            
            for course_id in course_ids:
                assert isinstance(course_id, int)
                await self._transport._send({'type': 'course.subscribe', 'oid': course_id})

            await self._transport._connect()

    """
    async def close(self):
        await self._transport.close()
        self.is_subscribed = False
    """

    @_ensure_login
    async def get_course(self, course_id: int) -> Course:
        if (course := next(filter(lambda x: x.id == course_id, await self.get_courses()), None)):
            return course
        raise RequestError('Invalid course ID.')

    @_ensure_login
    async def get_courses(self) -> t.List[Course]:
        res = await self._transport._request('GET', '/api/user')
        return [Course(course.get('course')) for course in res.get('courses')]

    @_ensure_login
    async def get_thread(self, thread_id) -> GetThreadType:

        res = await self._transport._request('GET', f'/api/threads/{thread_id}')
        thread = _build_thread(res.get('thread'))
        users = [CourseUser(user) for user in res.get('users', [])]
        return GetThreadType(thread=thread, users=users)

    @_ensure_login
    async def get_user_info(self) -> dict:
        """Retrieve the authenticated user's profile and enrolled courses."""

        return await self._transport._request('GET', '/api/user')

    @_ensure_login
    async def list_user_activity(
        self,
        user_id: int,
        course_id: int,
        *,
        limit: int = 30,
        offset: int = 0,
        filter: str = 'all',
    ) -> t.List[dict]:
        """List a user's recent activity within a course."""

        res = await self._transport._request(
            'GET',
            f'/api/users/{user_id}/profile/activity',
            params={
                'courseID': course_id,
                'limit': limit,
                'offset': offset,
                'filter': filter,
            },
        )
        return res.get('items', [])

    @_ensure_login
    async def list_threads(
        self,
        course_id: int,
        *,
        limit: int = 30,
        offset: int = 0,
        sort: str = 'new',
    ) -> ListThreadsType:
        """Retrieve a slice of threads within a course."""

        res = await self._transport._request(
            'GET',
            f'/api/courses/{course_id}/threads',
            params={'limit': limit, 'offset': offset, 'sort': sort},
        )
        threads = [_build_thread(thread) for thread in res.get('threads', [])]
        users = [CourseUser(user) for user in res.get('users', [])]
        return ListThreadsType(sort_key=res.get('sort_key', ''), threads=threads, users=users)

    @_ensure_login
    async def list_users(self, course_id: int) -> t.List[CourseUserWithEmail]:
        """Retrieve the roster for a course."""

        res = await self._transport._request('GET', f'/api/courses/{course_id}/analytics/users')
        return [CourseUserWithEmail(user) for user in res.get('users', [])]

    @_ensure_login
    async def get_course_thread(self, course_id: int, thread_number: int) -> Thread:
        """Fetch a thread using its course-specific number."""

        res = await self._transport._request(
            'GET', f'/api/courses/{course_id}/threads/{thread_number}'
        )
        return _build_thread(res.get('thread'))

    @_ensure_login
    async def post_thread(self, course_id: int, params: PostThreadParams) -> Thread:
        """Create a new thread within a course."""

        res = await self._transport._request(
            'POST', f'/api/courses/{course_id}/threads', json={'thread': params}
        )
        return _build_thread(res.get('thread'))

    @_ensure_login
    async def edit_thread(
        self,
        thread_id: int,
        params: EditThreadParams,
        *,
        unlock_thread: bool = True,
    ) -> Thread:
        """Update thread metadata, optionally unlocking the thread before editing."""

        thread_response = await self._transport._request('GET', f'/api/threads/{thread_id}')
        thread_payload = thread_response.get('thread', {})

        relock = False
        if unlock_thread and thread_payload.get('is_locked'):
            await self.unlock_thread(thread_id)
            relock = True
            thread_payload = (
                await self._transport._request('GET', f'/api/threads/{thread_id}')
            ).get('thread', thread_payload)

        for key, value in params.items():
            if key in thread_payload and value is not None:
                thread_payload[key] = value

        updated = await self._transport._request(
            'PUT', f'/api/threads/{thread_id}', json={'thread': thread_payload}
        )

        if relock:
            await self.lock_thread(thread_id)

        return _build_thread(updated.get('thread'))

    @_ensure_login
    async def lock_thread(self, thread_id: int) -> None:
        """Lock a thread to prevent new replies."""

        await self._transport._request(
            'POST', f'/api/threads/{thread_id}/lock', return_json=False
        )

    @_ensure_login
    async def unlock_thread(self, thread_id: int) -> None:
        """Unlock a thread so it can be edited or replied to again."""

        await self._transport._request(
            'POST', f'/api/threads/{thread_id}/unlock', return_json=False
        )

    @_ensure_login
    async def upload_file(self, filename: str, file: bytes, content_type: str) -> str:
        """Upload a file and return its static URL."""

        return await self._transport.upload_file(filename, file, content_type)


    def add_event_hooks(self, cls):
        
        methods = getmembers(cls, predicate=lambda meth: hasattr(meth, '__name__')
            and not meth.__name__.startswith('_') and ismethod(meth)
            and hasattr(meth, '_ed_events'))
        
        for _, listener in methods:
            events = listener._ed_events
            for event in events:
                self._event_hooks[event.__name__].append(listener)

    async def _dispatch_event(self, event):

        hooks = self._event_hooks[type(event).__name__]

        if not hooks:
            return
        
        async def _hook_wrapper(hook, event):
            await hook(event)

        tasks = [_hook_wrapper(hook, event) for hook in hooks]
        await asyncio.gather(*tasks)
