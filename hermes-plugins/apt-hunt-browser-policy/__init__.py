"""Apt's fail-closed, bounded browser Hunt tool policy."""

from collections import OrderedDict
import json
from threading import Lock


_BROWSER_TOOL_PREFIX = "browser_"
_MAX_BROWSER_CALLS_PER_TURN = 20
_MAX_BROWSER_NAVIGATIONS_PER_TURN = 7
_MAX_BROWSER_RESULT_CHARS = 9_000
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

_OBSERVED_LINK_SCHEMA = {
    "name": "browser_observed_link",
    "description": (
        "Resolve an exact product name already visible in the current browser "
        "snapshot to same-origin link destinations observed in the page DOM. "
        "This is read-only and does not navigate."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "product_name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 300,
                "description": "Exact product name copied from the current snapshot.",
            },
        },
        "required": ["product_name"],
        "additionalProperties": False,
    },
}


def _disabled_web_search(_args, **_kwargs):
    return "API-backed web_search is disabled for Apt browser Hunts."


def _observed_link(args, **kwargs):
    product_name = args.get("product_name") if isinstance(args, dict) else None
    if (
        not isinstance(product_name, str)
        or not product_name.strip()
        or len(product_name) > 300
        or any(ord(character) < 32 for character in product_name)
    ):
        return json.dumps({
            "success": False,
            "error": "product_name must be a visible 1-300 character product name.",
        })

    normalized_name = " ".join(product_name.split()).lower()
    needle = json.dumps(normalized_name)
    expression = (
        "JSON.stringify(Array.from(document.querySelectorAll(\"a[href]\"))"
        ".map(a=>({text:[a.innerText,a.getAttribute(\"aria-label\"),"
        "...Array.from(a.querySelectorAll(\"img[alt]\")).map(i=>i.alt)]"
        ".filter(Boolean).join(\" \").replace(/\\s+/g,\" \").trim(),href:a.href}))"
        f".filter(x=>x.text.toLowerCase().includes({needle})&&x.href&&"
        "x.href!==location.href&&new URL(x.href).origin===location.origin)"
        ".slice(0,5))"
    )
    from tools.browser_tool import browser_console

    return browser_console(expression=expression, task_id=kwargs.get("task_id"))


def _scope_key(kwargs):
    return str(
        kwargs.get("turn_id")
        or kwargs.get("task_id")
        or kwargs.get("session_id")
        or "unknown"
    )


def _call_key(kwargs):
    value = kwargs.get("tool_call_id")
    return str(value) if value else ""


def _on_pre_tool_call(tool_name=None, **kwargs):
    if not isinstance(tool_name, str) or not tool_name.startswith(_BROWSER_TOOL_PREFIX):
        return None

    scope = _scope_key(kwargs)
    session_id = str(kwargs.get("session_id") or "")
    if tool_name == "browser_console":
        return {
            "action": "block",
            "message": (
                "Apt blocks direct browser_console use. Resolve a product name "
                "already visible in the current snapshot with browser_observed_link."
            ),
        }
    with _turn_counts_lock:
        counts = _turn_counts.setdefault(
            scope,
            {
                "browser": 0,
                "navigate": 0,
                "session_id": session_id,
                "in_flight": set(),
                "last_tool": None,
                "last_result_had_snapshot": False,
            },
        )
        _turn_counts.move_to_end(scope)
        while len(_turn_counts) > _MAX_TRACKED_TURNS:
            _turn_counts.popitem(last=False)

        if counts["in_flight"]:
            return {
                "action": "block",
                "message": (
                    "Apt browser tools must run one at a time because they share one page. "
                    "Wait for the current browser result, then make one focused browser call."
                ),
            }

        if tool_name == "browser_observed_link" and counts["last_tool"] != "browser_snapshot":
            return {
                "action": "block",
                "message": (
                    "Use browser_observed_link only after browser_snapshot showed the "
                    "exact product name on the current page."
                ),
            }

        if tool_name == "browser_snapshot" and (
            counts["last_tool"] == "browser_snapshot"
            or (
                counts["last_tool"] == "browser_navigate"
                and counts["last_result_had_snapshot"]
            )
        ):
            return {
                "action": "block",
                "message": (
                    "Apt blocked a duplicate snapshot of the unchanged page. "
                    "Use the references and evidence already returned, then click, type, "
                    "press, go back, or finish the Hunt."
                ),
            }

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
        counts["last_tool"] = tool_name
        counts["last_result_had_snapshot"] = False
        call_key = _call_key(kwargs)
        if call_key:
            counts["in_flight"].add(call_key)
    return None


def _on_transform_tool_result(tool_name=None, result=None, **kwargs):
    if isinstance(tool_name, str) and tool_name.startswith(_BROWSER_TOOL_PREFIX):
        scope = _scope_key(kwargs)
        call_key = _call_key(kwargs)
        if call_key:
            with _turn_counts_lock:
                counts = _turn_counts.get(scope)
                if counts is not None:
                    counts["in_flight"].discard(call_key)
                    if tool_name == "browser_navigate" and isinstance(result, str):
                        try:
                            payload = json.loads(result)
                        except (TypeError, ValueError):
                            payload = None
                        counts["last_result_had_snapshot"] = bool(
                            isinstance(payload, dict) and payload.get("snapshot")
                        )

    if (
        not isinstance(tool_name, str)
        or not tool_name.startswith(_BROWSER_TOOL_PREFIX)
        or not isinstance(result, str)
        or len(result) <= _MAX_BROWSER_RESULT_CHARS
    ):
        return None

    notice = (
        "\n\n[Browser output compacted by Apt. The beginning and end are preserved "
        "so product, menu, price, availability, and source-link evidence is less likely "
        "to be hidden by site chrome. Do not repeat this navigation.]\n\n"
    )
    available = _MAX_BROWSER_RESULT_CHARS - len(notice)
    head = max(1, available // 3)
    tail = available - head
    return result[:head] + notice + result[-tail:]


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
    ctx.register_tool(
        name="browser_observed_link",
        toolset="browser",
        schema=_OBSERVED_LINK_SCHEMA,
        handler=_observed_link,
        check_fn=lambda: True,
        description="Read-only observed product-link resolver for Apt browser Hunts.",
        emoji="🔗",
    )
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("transform_tool_result", _on_transform_tool_result)
    ctx.register_hook("on_session_end", _on_session_end)
