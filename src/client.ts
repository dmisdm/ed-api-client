import { AuthenticationError, RequestError } from './errors';
import {
  ClientConfig,
  NormalizedClientConfig,
  Course,
  Thread,
  Comment,
  EventHandler,
  EventName,
  EventPayload,
  ThreadResponse,
  UserResponse,
  Region,
  ThreadEventName,
  CommentEventName,
} from './types';

type OutgoingMessage = Record<string, unknown> & { id?: number };

type WebSocketLike = WebSocket & {
  close(code?: number, reason?: string): void;
};

const REGION_HOSTS: Record<Region, string> = {
  us: 'us.edstem.org',
  au: 'au.edstem.org',
  eu: 'eu.edstem.org',
};

const DEFAULT_RECONNECT_DELAY = 5_000;

function resolveHost(region: Region | undefined): string {
  if (!region) {
    return REGION_HOSTS.au;
  }
  const host = REGION_HOSTS[region] ?? REGION_HOSTS.au;
  return host;
}

function normalizeConfig(config: ClientConfig): NormalizedClientConfig {
  const host = resolveHost(config.region);
  const baseUrl = config.baseUrl ?? `https://${host}`;
  const websocketUrl = config.websocketUrl ?? `wss://${host}`;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('A fetch implementation is required. Pass fetchImpl in the client configuration.');
  }

  const WebSocketImpl = config.WebSocketImpl ?? globalThis.WebSocket;
  if (!WebSocketImpl) {
    throw new Error('A WebSocket implementation is required. Pass WebSocketImpl in the client configuration.');
  }

  const logger = config.logger ?? console;

  return {
    apiKey: config.apiKey,
    baseUrl,
    websocketUrl,
    fetchImpl,
    WebSocketImpl,
    logger,
    reconnectDelayMs: config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY,
  };
}

function isResponseJson(res: Response): boolean {
  const contentType = res.headers.get('content-type') ?? '';
  return contentType.includes('application/json');
}

export class EdAPIClient {
  private readonly config: NormalizedClientConfig;

  private loggedIn = false;

  private websocket?: WebSocketLike;

  private connectPromise: Promise<void> | null = null;

  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  private closing = false;

  private isSubscribed = false;

  private readonly messageQueue: OutgoingMessage[] = [];

  private readonly sentMessages = new Map<number, OutgoingMessage>();

  private messageId = 0;

  private readonly eventHandlers: Map<EventName, Set<EventHandler>> = new Map();

  private cachedCourses: Course[] | null = null;

  private subscribedCourseIds: number[] = [];

  constructor(config: ClientConfig) {
    this.config = normalizeConfig(config);
    const eventNames: EventName[] = [
      'thread.new',
      'thread.update',
      'thread.delete',
      'comment.new',
      'comment.update',
      'comment.delete',
      'course.count',
    ];
    for (const name of eventNames) {
      this.eventHandlers.set(name, new Set());
    }
  }

  /** Register an event handler. */
  on<T extends EventPayload>(event: T['type'], handler: EventHandler<T>): () => void {
    const listeners = this.eventHandlers.get(event as EventName);
    if (!listeners) {
      throw new Error(`Unsupported event: ${event}`);
    }
    listeners.add(handler as EventHandler);
    return () => this.off(event, handler);
  }

  /** Remove a specific event handler. */
  off<T extends EventPayload>(event: T['type'], handler: EventHandler<T>): void {
    const listeners = this.eventHandlers.get(event as EventName);
    listeners?.delete(handler as EventHandler);
  }

  /** Remove all registered listeners. */
  removeAllListeners(): void {
    for (const listeners of this.eventHandlers.values()) {
      listeners.clear();
    }
  }

  async getCourses(): Promise<Course[]> {
    await this.ensureLoggedIn();
    if (this.cachedCourses) {
      return this.cachedCourses;
    }
    const response = await this.request<UserResponse>('GET', '/api/user');
    this.cachedCourses = response.courses.map(({ course }) => course);
    return this.cachedCourses;
  }

  async getCourse(courseId: number): Promise<Course> {
    const courses = await this.getCourses();
    const course = courses.find((item) => item.id === courseId);
    if (!course) {
      throw new RequestError('Invalid course ID.');
    }
    return course;
  }

  async getThread(threadId: number): Promise<ThreadResponse> {
    await this.ensureLoggedIn();
    return this.request<ThreadResponse>('GET', `/api/threads/${threadId}`);
  }

  async subscribe(courseIds?: number | number[]): Promise<void> {
    await this.ensureLoggedIn();
    this.isSubscribed = true;
    const normalizedIds = await this.normalizeCourseIds(courseIds);
    this.subscribedCourseIds = [...new Set(normalizedIds)].sort((a, b) => a - b);
    this.sentMessages.clear();
    this.queueSubscriptionMessages();
    await this.connectWebSocket();
  }

  async close(): Promise<void> {
    this.isSubscribed = false;
    this.closing = true;
    this.clearReconnect();
    this.messageQueue.length = 0;
    this.sentMessages.clear();
    this.subscribedCourseIds = [];
    if (this.websocket && this.websocket.readyState === 1) {
      this.websocket.close(1000, 'Client closing connection');
    } else if (this.websocket && this.websocket.readyState === 0) {
      this.websocket.close();
    }
    this.websocket = undefined;
    this.connectPromise = null;
    this.closing = false;
  }

  private async ensureLoggedIn(): Promise<void> {
    if (this.loggedIn) {
      return;
    }
    await this.login();
  }

  private async login(): Promise<void> {
    const response = await this.request<UserResponse>('GET', '/api/user');
    this.loggedIn = true;
    this.cachedCourses = response.courses.map(({ course }) => course);
    const name = response.user.name ?? 'unknown user';
    const email = response.user.email ? ` (${response.user.email})` : '';
    this.config.logger.info(`Logged in as ${name}${email}`);
  }

  private async request<T>(method: string, endpoint: string): Promise<T> {
    const url = new URL(endpoint, this.config.baseUrl).toString();
    const res = await this.config.fetchImpl(url, {
      method,
      headers: {
        Authorization: this.config.apiKey,
      },
    });

    if (!res.ok) {
      if (res.status === 400) {
        throw new AuthenticationError('Invalid Ed API token.');
      }
      if (res.status === 403) {
        throw new RequestError('Missing permission', res.status);
      }
      if (res.status === 404) {
        throw new RequestError('Invalid API endpoint.', res.status);
      }
      throw new RequestError(`Unexpected response: ${res.status} ${res.statusText}`, res.status);
    }

    if (!isResponseJson(res)) {
      throw new RequestError('Expected JSON response from Ed API.');
    }

    return (await res.json()) as T;
  }

  private async normalizeCourseIds(ids?: number | number[]): Promise<number[]> {
    if (!ids) {
      const courses = await this.getCourses();
      return courses.map((course) => course.id);
    }
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      if (typeof id !== 'number' || Number.isNaN(id)) {
        throw new RequestError('Course IDs must be numeric values.');
      }
    }
    return list;
  }

  private async connectWebSocket(): Promise<void> {
    if (this.websocket && this.websocket.readyState === 1) {
      await this.flushQueue();
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      let resolved = false;
      const ws = this.createWebSocket();
      this.websocket = ws;

      ws.onopen = async () => {
        resolved = true;
        this.config.logger.info('Connection to websocket established.');
        try {
          await this.flushQueue();
          resolve();
        } catch (error) {
          reject(error);
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          void this.handleMessage(data);
        } catch (error) {
          this.config.logger.warn('Unable to decode websocket message.', error);
        }
      };

      ws.onerror = (event) => {
        this.config.logger.error('Websocket connection error', event);
        if (!resolved) {
          reject(new Error('Websocket connection failed'));
        }
      };

      ws.onclose = (event) => {
        this.websocket = undefined;
        if (!resolved) {
          reject(new Error(`Websocket closed before ready: ${event.code}`));
        }
        this.config.logger.warn(`WebSocket disconnected with code=${event.code}`);
        this.handleDisconnect();
      };
    });

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private createWebSocket(): WebSocketLike {
    const url = new URL('/api/stream', this.config.websocketUrl).toString();
    const WebSocketImpl = this.config.WebSocketImpl as unknown as {
      new (url: string, protocols?: string | string[], options?: Record<string, unknown>): WebSocketLike;
    };

    try {
      return new WebSocketImpl(url, [], { headers: { Authorization: this.config.apiKey } });
    } catch {
      const wsUrl = new URL(url);
      wsUrl.searchParams.set('token', this.config.apiKey);
      return new WebSocketImpl(wsUrl.toString());
    }
  }

  private async flushQueue(): Promise<void> {
    if (!this.websocket || this.websocket.readyState !== 1) {
      return;
    }
    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        await this.send(message);
      }
    }
  }

  private queueMessage(data: OutgoingMessage): void {
    const payload = { ...data };
    payload.id = ++this.messageId;
    this.sentMessages.set(payload.id, payload);

    if (!this.websocket || this.websocket.readyState !== 1) {
      this.config.logger.debug?.('WebSocket not ready; queued outgoing payload.', payload);
      this.messageQueue.push(payload);
      return;
    }

    void this.send(payload);
  }

  private queueSubscriptionMessages(): void {
    if (this.subscribedCourseIds.length === 0) {
      return;
    }
    for (const id of this.subscribedCourseIds) {
      this.queueMessage({ type: 'course.subscribe', oid: id });
    }
  }

  private async send(message: OutgoingMessage): Promise<void> {
    if (!this.websocket || this.websocket.readyState !== 1) {
      this.messageQueue.push(message);
      return;
    }
    this.config.logger.debug?.('Sending payload', message);
    this.websocket.send(JSON.stringify(message));
  }

  private handleDisconnect(): void {
    if (this.closing || !this.isSubscribed) {
      return;
    }
    this.clearReconnect();
    this.reconnectTimeout = setTimeout(() => {
      this.sentMessages.clear();
      this.messageQueue.length = 0;
      this.queueSubscriptionMessages();
      this.connectWebSocket().catch((error) => {
        this.config.logger.error('Failed to reconnect websocket', error);
      });
    }, this.config.reconnectDelayMs);
  }

  private clearReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private async handleMessage(message: any): Promise<void> {
    const eventType: string | undefined = message?.type;
    const data = message?.data;

    if (!eventType) {
      return;
    }

    if (eventType === 'chat.init') {
      return;
    }

    if (eventType === 'course.subscribe') {
      const sent = this.sentMessages.get(message.id);
      if (sent?.oid) {
        this.config.logger.info?.(`Course ${sent.oid} subscribed.`);
      }
      if (message.id) {
        this.sentMessages.delete(message.id);
      }
      return;
    }

    if (eventType.startsWith('thread.')) {
      const threadData: Thread | undefined = data?.thread ?? data;
      if (!threadData) {
        return;
      }
      await this.dispatch({ type: eventType as ThreadEventName, thread: threadData });
      return;
    }

    if (eventType.startsWith('comment.')) {
      const commentData: Comment | undefined = data?.comment ?? data;
      if (!commentData) {
        return;
      }
      await this.dispatch({ type: eventType as CommentEventName, comment: commentData });
      return;
    }

    if (eventType === 'course.count') {
      const courseId = data?.id;
      const count = data?.count;
      if (typeof courseId === 'number' && typeof count === 'number') {
        await this.dispatch({ type: 'course.count', courseId, count });
      }
      return;
    }

    this.config.logger.warn?.(`Unknown event received: ${eventType}`);
  }

  private async dispatch(payload: EventPayload): Promise<void> {
    const listeners = this.eventHandlers.get(payload.type as EventName);
    if (!listeners || listeners.size === 0) {
      return;
    }
    await Promise.all(
      Array.from(listeners).map(async (listener) => {
        try {
          await listener(payload as never);
        } catch (error) {
          this.config.logger.error('Event handler threw an error', error);
        }
      }),
    );
  }
}

export function createEdAPIClient(config: ClientConfig): EdAPIClient {
  return new EdAPIClient(config);
}
