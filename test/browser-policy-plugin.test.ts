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

spec = importlib.util.spec_from_file_location("apt_hunt_browser_policy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Context:
    def __init__(self):
        self.hooks = []
        self.tool = None

    def has_capability(self, capability):
        return capability == "tools.override"

    def register_tool(self, **kwargs):
        self.tool = kwargs

    def register_hook(self, name, handler):
        self.hooks.append(name)

context = Context()
module.register(context)
scope = {"turn_id": "turn-1", "session_id": "session-1"}
navigate = [
    module._on_pre_tool_call(tool_name="browser_navigate", **scope)
    for _ in range(6)
]
navigation_block = module._on_pre_tool_call(tool_name="browser_navigate", **scope)
remaining = [
    module._on_pre_tool_call(tool_name="browser_snapshot", **scope)
    for _ in range(4)
]
total_block = module._on_pre_tool_call(tool_name="browser_click", **scope)
large = "x" * 7000
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
    "override": context.tool["override"],
    "navigate_allowed": all(item is None for item in navigate),
    "navigation_block": navigation_block,
    "remaining_allowed": all(item is None for item in remaining),
    "total_block": total_block,
    "compacted_length": len(compacted),
    "compacted_notice": "Browser output compacted by Apt" in compacted,
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
      navigate_allowed: true,
      remaining_allowed: true,
      compacted_length: 6000,
      compacted_notice: true,
      short_unchanged: true,
      non_browser_unchanged: true,
      after_reset_allowed: true,
    });
    expect(result.navigation_block).toMatchObject({ action: 'block' });
    expect(result.total_block).toMatchObject({ action: 'block' });
  });
});
