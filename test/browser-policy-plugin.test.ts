import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pluginPath = fileURLToPath(new URL(
  '../hermes-plugins/apt-hunt-browser-policy/__init__.py',
  import.meta.url,
));

const exercisePlugin = String.raw`
import importlib.util
import json
import sys
import types

spec = importlib.util.spec_from_file_location("apt_hunt_browser_policy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Context:
    def __init__(self):
        self.hooks = []
        self.tools = {}

    def has_capability(self, capability):
        return capability == "tools.override"

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs

    def register_hook(self, name, handler):
        self.hooks.append(name)

context = Context()
module.register(context)
observed_console_calls = []
browser_tool = types.ModuleType("tools.browser_tool")
def fake_browser_console(clear=False, expression=None, task_id=None):
    observed_console_calls.append({"expression": expression, "task_id": task_id})
    return json.dumps({"success": True, "result": "observed"})
browser_tool.browser_console = fake_browser_console
tools_module = types.ModuleType("tools")
tools_module.browser_tool = browser_tool
sys.modules["tools"] = tools_module
sys.modules["tools.browser_tool"] = browser_tool
observed_handler_result = context.tools["browser_observed_link"]["handler"](
    {"product_name": "Men's Winter Boot"},
    task_id="observed-task",
)
invalid_observed_handler_result = context.tools["browser_observed_link"]["handler"](
    {"product_name": "bad\nname"},
    task_id="observed-task",
)
scope = {"turn_id": "turn-1", "session_id": "session-1"}

def run_browser(tool_name, index, result="ok"):
    call = {**scope, "tool_call_id": f"call-{index}"}
    decision = module._on_pre_tool_call(tool_name=tool_name, **call)
    if decision is None:
        module._on_transform_tool_result(tool_name=tool_name, result=result, **call)
    return decision

navigate = [
    run_browser("browser_navigate", index)
    for index in range(7)
]
navigation_block = module._on_pre_tool_call(tool_name="browser_navigate", **scope)
remaining = [
    run_browser("browser_click", index + 7)
    for index in range(13)
]
total_block = module._on_pre_tool_call(tool_name="browser_click", **scope)

snapshot_scope = {"turn_id": "turn-snapshot", "session_id": "session-1"}
first_snapshot = {**snapshot_scope, "tool_call_id": "snapshot-1"}
first_snapshot_allowed = module._on_pre_tool_call(tool_name="browser_snapshot", **first_snapshot)
module._on_transform_tool_result(tool_name="browser_snapshot", result="page", **first_snapshot)
duplicate_snapshot = module._on_pre_tool_call(
    tool_name="browser_snapshot",
    **{**snapshot_scope, "tool_call_id": "snapshot-2"},
)

navigate_snapshot_scope = {"turn_id": "turn-navigate-snapshot", "session_id": "session-1"}
navigate_snapshot_call = {**navigate_snapshot_scope, "tool_call_id": "navigate-snapshot-1"}
module._on_pre_tool_call(tool_name="browser_navigate", **navigate_snapshot_call)
module._on_transform_tool_result(
    tool_name="browser_navigate",
    result=json.dumps({"success": True, "snapshot": "page"}),
    **navigate_snapshot_call,
)
snapshot_after_navigation = module._on_pre_tool_call(
    tool_name="browser_snapshot",
    **{**navigate_snapshot_scope, "tool_call_id": "navigate-snapshot-2"},
)

console_blocked = module._on_pre_tool_call(
    tool_name="browser_console",
    args={"expression": "document.cookie"},
    **{"turn_id": "turn-console", "session_id": "session-1", "tool_call_id": "console-1"},
)
location_console_blocked = module._on_pre_tool_call(
    tool_name="browser_console",
    args={"expression": "location.href"},
    **{"turn_id": "turn-location-console", "session_id": "session-1", "tool_call_id": "console-2"},
)

observed_scope = {"turn_id": "turn-observed", "session_id": "session-1"}
observed_snapshot = {**observed_scope, "tool_call_id": "observed-snapshot"}
module._on_pre_tool_call(tool_name="browser_snapshot", **observed_snapshot)
module._on_transform_tool_result(tool_name="browser_snapshot", result="product catalog", **observed_snapshot)
observed_link_allowed = module._on_pre_tool_call(
    tool_name="browser_observed_link",
    args={"product_name": "Men's Winter Boot"},
    **{**observed_scope, "tool_call_id": "observed-link"},
)
module._on_transform_tool_result(
    tool_name="browser_observed_link",
    result="observed link",
    **{**observed_scope, "tool_call_id": "observed-link"},
)
early_observed_link_blocked = module._on_pre_tool_call(
    tool_name="browser_observed_link",
    args={"product_name": "Men's Winter Boot"},
    **{"turn_id": "turn-early-observed", "session_id": "session-1", "tool_call_id": "observed-early"},
)

parallel_scope = {"turn_id": "turn-2", "session_id": "session-1"}
first_call = {**parallel_scope, "tool_call_id": "parallel-1"}
second_call = {**parallel_scope, "tool_call_id": "parallel-2"}
first_allowed = module._on_pre_tool_call(tool_name="browser_navigate", **first_call)
parallel_block = module._on_pre_tool_call(tool_name="browser_navigate", **second_call)
module._on_transform_tool_result(tool_name="browser_navigate", result="done", **first_call)
after_parallel = module._on_pre_tool_call(tool_name="browser_snapshot", **second_call)
module._on_transform_tool_result(tool_name="browser_snapshot", result="done", **second_call)

large = "x" * 10000
compacted = module._on_transform_tool_result(
    tool_name="browser_snapshot",
    result=large,
)
module._on_session_end(session_id="session-1")
after_reset = module._on_pre_tool_call(
    tool_name="browser_navigate",
    **scope,
)

print(json.dumps({
    "hooks": context.hooks,
    "override": context.tools["web_search"]["override"],
    "registered_tools": sorted(context.tools.keys()),
    "observed_schema_required": context.tools["browser_observed_link"]["schema"]["parameters"]["required"],
    "observed_handler_result": json.loads(observed_handler_result),
    "invalid_observed_handler_result": json.loads(invalid_observed_handler_result),
    "observed_console_calls": observed_console_calls,
    "navigate_allowed": all(item is None for item in navigate),
    "navigation_block": navigation_block,
    "remaining_allowed": all(item is None for item in remaining),
    "total_block": total_block,
    "first_snapshot_allowed": first_snapshot_allowed is None,
    "duplicate_snapshot": duplicate_snapshot,
    "snapshot_after_navigation": snapshot_after_navigation,
    "console_blocked": console_blocked,
    "location_console_blocked": location_console_blocked,
    "observed_link_allowed": observed_link_allowed is None,
    "early_observed_link_blocked": early_observed_link_blocked,
    "first_allowed": first_allowed is None,
    "parallel_block": parallel_block,
    "after_parallel_allowed": after_parallel is None,
    "compacted_length": len(compacted),
    "compacted_notice": "Browser output compacted by Apt" in compacted,
    "compacted_tail": compacted.endswith("x" * 100),
    "short_unchanged": module._on_transform_tool_result(
        tool_name="browser_snapshot",
        result="short",
    ) is None,
    "non_browser_unchanged": module._on_transform_tool_result(
        tool_name="apt_commerce_hunt",
        result=large,
    ) is None,
    "after_reset_allowed": after_reset is None,
}))
`;

describe('Hermes browser Hunt policy plugin', () => {
  it('bounds browser calls and compacts only oversized browser results', () => {
    const output = execFileSync('python3', ['-c', exercisePlugin, pluginPath], { encoding: 'utf8' });
    const result = JSON.parse(output) as Record<string, unknown>;

    expect(result).toMatchObject({
      hooks: ['pre_tool_call', 'transform_tool_result', 'on_session_end'],
      override: true,
      registered_tools: ['browser_observed_link', 'web_search'],
      observed_schema_required: ['product_name'],
      observed_handler_result: { success: true, result: 'observed' },
      navigate_allowed: true,
      remaining_allowed: true,
      first_allowed: true,
      after_parallel_allowed: true,
      compacted_length: 9000,
      compacted_notice: true,
      compacted_tail: true,
      short_unchanged: true,
      non_browser_unchanged: true,
      after_reset_allowed: true,
    });
    expect(result.navigation_block).toMatchObject({ action: 'block' });
    expect(result.total_block).toMatchObject({ action: 'block' });
    expect(result.first_snapshot_allowed).toBe(true);
    expect(result.duplicate_snapshot).toMatchObject({ action: 'block' });
    expect(result.snapshot_after_navigation).toMatchObject({ action: 'block' });
    expect(result.console_blocked).toMatchObject({ action: 'block' });
    expect(result.location_console_blocked).toMatchObject({ action: 'block' });
    expect(result.observed_link_allowed).toBe(true);
    expect(result.early_observed_link_blocked).toMatchObject({ action: 'block' });
    expect(result.invalid_observed_handler_result).toMatchObject({ success: false });
    expect(result.observed_console_calls).toHaveLength(1);
    expect(result.observed_console_calls).toEqual([
      expect.objectContaining({ task_id: 'observed-task' }),
    ]);
    expect((result.observed_console_calls as Array<{ expression: string }>)[0]!.expression).toContain(
      '.includes("men\'s winter boot")',
    );
    expect(result.parallel_block).toMatchObject({ action: 'block' });
  });
});
