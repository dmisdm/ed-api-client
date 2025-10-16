class CourseUser:

    __slots__ = ('_raw', 'avatar', 'course_role', 'id', 'name', 'role', 'tutorials')

    avatar: str
    course_role: str
    id: int
    name: str
    role: str
    tutorials: dict[int, str]

    def __init__(self, data):
        self._raw = data
        for slot in self.__slots__:
            setattr(self, slot, data.get(slot))

    def __repr__(self):
        return f'<CourseUser name={self.name} id={self.id}>'


class CourseUserWithEmail(CourseUser):

    __slots__ = CourseUser.__slots__ + ('email', 'username')

    email: str
    username: str

    def __init__(self, data):
        super().__init__(data)
        self.email = data.get('email')
        self.username = data.get('username')

    def __repr__(self):
        return f'<CourseUserWithEmail name={self.name} email={self.email} id={self.id}>'