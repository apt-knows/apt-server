drop index public.messages_reply_to_idx;
drop index public.agent_runs_request_message_idx;
drop index public.agent_runs_response_message_idx;

create index messages_user_reply_to_idx on public.messages(user_id, reply_to_message_id);
create index agent_runs_user_request_message_idx on public.agent_runs(user_id, request_message_id);
create index agent_runs_user_response_message_idx on public.agent_runs(user_id, response_message_id);
