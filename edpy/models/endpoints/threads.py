import typing as t

from ..thread import Thread
from ..user import CourseUser

class GetThreadType:

    def __init__(self, thread: Thread, users: t.List[CourseUser]) -> None:
        self.thread: Thread = thread
        self.users: t.List[CourseUser] = users


class ListThreadsType:

    def __init__(self, sort_key: str, threads: t.List[Thread], users: t.List[CourseUser]) -> None:
        self.sort_key: str = sort_key
        self.threads: t.List[Thread] = threads
        self.users: t.List[CourseUser] = users
