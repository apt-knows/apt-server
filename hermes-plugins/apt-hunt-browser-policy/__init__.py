"""Apt's fail-closed, bounded browser Hunt tool policy."""

from collections import OrderedDict
from threading import Lock


_BROWSER_TOOL_PREFIX = "browser_"
_MAX_BROWSER_CALLS_PER_TURN = 10
_MAX_BROWSER_NAVIGATIONS_PER_TURN = 6
_MAX_BROWSER_RESULT_CHARS = 6_000
_MAX_TRACKED_TURNS = 256
_turn_counts = OrderedDict()
_turn_counts_lock = Lock()

_DISABLED_WEB_SEARCH_SCHEMA = {
    "name": "web_search",
    "description": (
        "Disabled for Apt. Commerce Hunts must navigate and interact with "
        "public websites through browser tools."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}


def _disabled_web_search(_args, **_kwargs):
    return "API-backed web_search is disabled for Apt browser Hunts."


def _scope_key(kwargs):
    return str(
        kwargs.get("turn_id")
        or kwargs.get("task_id")
        or kwargs.get("session_id")
        or "unknown"
    )


def _on_pre_tool_call(tool_name=None, **kwargs):
    if not isinstance(tool_name, str) or not tool_name.startswith(_BROWSER_TOOL_PREFIX):
        return None

    scope = _scope_key(kwargs)
    session_id = str(kwargs.get("session_id") or "")
    with _turn_counts_lock:
        counts = _turn_counts.setdefault(
            scope,
            {"browser": 0, "navigate": 0, "session_id": session_id},
        )
        _turn_counts.move_to_end(scope)
        while len(_turn_counts) > _MAX_TRACKED_TURNS:
            _turn_counts.popitem(last=False)

        if counts["browser"] >= _MAX_BROWSER_CALLS_PER_TURN:
            return {
                "action": "block",
                "message": (
                    "Apt browser Hunt budget reached. Do not call another browser tool. "
                    "Call apt_commerce_hunt now with the best candidates already observed, "
                    "or explain that current evidence was insufficient."
                ),
            }
        if (
            tool_name == "browser_navigate"
            and counts["navigate"] >= _MAX_BROWSER_NAVIGATIONS_PER_TURN
        ):
            return {
                "action": "block",
                "message": (
                    "Apt browser navigation budget reached. Do not navigate again. "
                    "Use the current page only if another non-navigation browser action is essential, "
                    "then call apt_commerce_hunt with observed candidates or report insufficient evidence."
                ),
            }

        counts["browser"] += 1
        if tool_name == "browser_navigate":
            counts["navigate"] += 1
    return None


def _on_transform_tool_result(tool_name=None, result=None, **_kwargs):
    if (
        not isinstance(tool_name, str)
        or not tool_name.startswith(_BROWSER_TOOL_PREFIX)
        or not isinstance(result, str)
        or len(result) <= _MAX_BROWSER_RESULT_CHARS
    ):
        return None

    suffix = (
        "\n\n[Browser output compacted by Apt. Use the evidence above; do not repeat "
        "the same navigation. Continue with focused interaction or submit the Hunt.]"
    )
    return result[: _MAX_BROWSER_RESULT_CHARS - len(suffix)] + suffix


def _on_session_end(session_id=None, **_kwargs):
    if session_id is None:
        return None
    target = str(session_id)
    with _turn_counts_lock:
        stale = [
            scope
            for scope, counts in _turn_counts.items()
            if counts.get("session_id") == target
        ]
        for scope in stale:
            _turn_counts.pop(scope, None)
    return None


def register(ctx):
    if not ctx.has_capability("tools.override"):
        raise RuntimeError("Apt browser policy requires the tools.override grant.")
    ctx.register_tool(
        name="web_search",
        toolset="browser",
        schema=_DISABLED_WEB_SEARCH_SCHEMA,
        handler=_disabled_web_search,
        check_fn=lambda: False,
        description="Fail-closed Apt override for API-backed web search.",
        override=True,
    )
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("transform_tool_result", _on_transform_tool_result)
    ctx.register_hook("on_session_end", _on_session_end)
