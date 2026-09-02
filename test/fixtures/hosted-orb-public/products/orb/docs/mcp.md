# Hosted Orb MCP public contract fixture

This projection fixture preserves the reviewed tool-to-scope boundary without
requiring an additional runtime checkout.

| Tool | Scope |
| --- | --- |
| `orb_list_hosted_runtime_profiles` | `tasks:read` |
| `computer_launch` | `executor:write` + `tasks:write` + `threads:write` |
| `orb_launch_hosted_task` | `executor:write` + `tasks:write` + `threads:write` |
| `orb_create_thread` | `threads:write` |
| `orb_start_task` | `executor:write` |
| `orb_wait_task` | `threads:read` |
| `orb_send_message` | `threads:write` |
| `orb_get_thread` | `threads:read` |
| `orb_list_pending_approvals` | `threads:read` |
| `orb_decide_approval` | `approvals:write` |
| `orb_task_status` | `tasks:read` |
| `orb_direct_task` | `tasks:write` |
| `orb_cancel_task` | `tasks:write` |
