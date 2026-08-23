"""Apt's fail-closed browser Hunt tool policy."""

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
