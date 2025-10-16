export type Region = 'us' | 'au' | 'eu';

export interface ClientConfig {
  apiKey: string;
  /** Region slug used to build the Ed base URL. */
  region?: Region;
  /** Override the HTTPS endpoint (defaults to https://<region>.edstem.org). */
  baseUrl?: string;
  /** Optional websocket endpoint override (defaults to wss://<region>.edstem.org). */
  websocketUrl?: string;
  /** Custom fetch implementation for environments without a global fetch. */
  fetchImpl?: typeof fetch;
  /** Custom WebSocket constructor for environments without a global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  /** Optional logger interface (defaults to console). */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  /** Delay (in milliseconds) before reconnecting the websocket. */
  reconnectDelayMs?: number;
}

export interface NormalizedClientConfig {
  apiKey: string;
  baseUrl: string;
  websocketUrl: string;
  fetchImpl: typeof fetch;
  WebSocketImpl: typeof WebSocket;
  logger: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  reconnectDelayMs: number;
}

export interface Course {
  id: number;
  realm_id?: number;
  code?: string;
  name?: string;
  year?: string;
  session?: string;
  status?: string;
  features?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  created_at?: string;
  is_lab_regex_active?: boolean;
  [key: string]: unknown;
}

export interface CourseUser {
  id: number;
  name?: string;
  avatar?: string;
  role?: string;
  course_role?: string;
  email?: string;
  username?: string;
  tutorials?: Record<string, string>;
  [key: string]: unknown;
}

export type ThreadType = 'post' | 'question' | 'announcement';

export interface Thread {
  id: number;
  user_id?: number;
  course_id?: number;
  type?: ThreadType;
  title?: string;
  content?: string;
  document?: string;
  category?: string;
  subcategory?: string;
  subsubcategory?: string;
  flag_count?: number;
  star_count?: number;
  view_count?: number;
  unique_view_count?: number;
  vote_count?: number;
  reply_count?: number;
  unresolved_count?: number;
  is_locked?: boolean;
  is_pinned?: boolean;
  is_private?: boolean;
  is_endorsed?: boolean;
  is_answered?: boolean;
  is_student_answered?: boolean;
  is_staff_answered?: boolean;
  is_archived?: boolean;
  is_anonymous?: boolean;
  is_megathread?: boolean;
  anonymous_comments?: boolean;
  approved_status?: string;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  pinned_at?: string | null;
  anonymous_id?: number;
  vote?: number;
  is_seen?: boolean;
  is_starred?: boolean;
  is_watched?: boolean;
  glanced_at?: string;
  new_reply_count?: number;
  duplicate_title?: string | null;
  answers?: Comment[];
  comments?: Comment[];
  user?: CourseUser;
  [key: string]: unknown;
}

export interface Comment {
  id: number;
  user_id?: number;
  course_id?: number;
  thread_id?: number;
  original_id?: number | null;
  parent_id?: number | null;
  editor_id?: number | null;
  number?: number;
  type?: string;
  kind?: string;
  content?: string;
  document?: string;
  flag_count?: number;
  vote_count?: number;
  is_endorsed?: boolean;
  is_anonymous?: boolean;
  is_private?: boolean;
  is_resolved?: boolean;
  created_at?: string;
  updated_at?: string | null;
  deleted_at?: string | null;
  anonymous_id?: number;
  vote?: number;
  comments?: Comment[];
  user?: CourseUser;
  [key: string]: unknown;
}

export interface UserResponse {
  user: CourseUser;
  courses: Array<{ course: Course }>;
}

export interface ThreadResponse {
  thread: Thread;
  users: CourseUser[];
}

export interface ThreadListResponse {
  sort_key?: string;
  threads?: Thread[];
  users?: CourseUser[];
}

export interface ThreadListResult {
  sortKey: string;
  threads: Thread[];
  users: CourseUser[];
}

export type UserActivityItem = Record<string, unknown>;

export interface PostThreadParams {
  type: ThreadType;
  title: string;
  category: string;
  subcategory: string;
  subsubcategory: string;
  content: string;
  is_pinned: boolean;
  is_private: boolean;
  is_anonymous: boolean;
  is_megathread: boolean;
  anonymous_comments: boolean;
}

export type EditThreadParams = Partial<PostThreadParams>;

export type CourseCount = {
  course_id: number;
  count: number;
};

export type ThreadEventName = 'thread.new' | 'thread.update' | 'thread.delete';
export type CommentEventName = 'comment.new' | 'comment.update' | 'comment.delete';
export type CourseEventName = 'course.count';

export type EventName = ThreadEventName | CommentEventName | CourseEventName;

export interface ThreadEventPayload {
  type: ThreadEventName;
  thread: Thread;
}

export interface CommentEventPayload {
  type: CommentEventName;
  comment: Comment;
}

export interface CourseCountEventPayload {
  type: 'course.count';
  courseId: number;
  count: number;
}

export type EventPayload =
  | ThreadEventPayload
  | CommentEventPayload
  | CourseCountEventPayload;

export type EventHandler<T extends EventPayload = EventPayload> = (event: T) => void | Promise<void>;
