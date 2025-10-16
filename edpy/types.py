from typing import TypedDict


class EditThreadParams(TypedDict, total=False):
    """Parameters for editing an existing thread."""

    type: str
    title: str
    category: str
    subcategory: str
    subsubcategory: str
    content: str
    is_pinned: bool
    is_private: bool
    is_anonymous: bool
    is_megathread: bool
    anonymous_comments: bool


class PostThreadParams(TypedDict):
    """Parameters required for creating a thread."""

    type: str
    title: str
    category: str
    subcategory: str
    subsubcategory: str
    content: str
    is_pinned: bool
    is_private: bool
    is_anonymous: bool
    is_megathread: bool
    anonymous_comments: bool
