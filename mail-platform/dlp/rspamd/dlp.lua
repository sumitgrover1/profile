--[[
  mailstack DLP — Rspamd plugin

  Why Rspamd and not a standalone milter: Rspamd is already installed by the
  mailstack bootstrap, already runs as a before-queue milter on Postfix, and
  already has the scoring model this needs. Adding a second milter to the chain
  would double the parsing work and add another thing that can wedge the queue.

  Flow:
    Postfix (submission) -> Rspamd milter -> this plugin
      -> POST the raw message to the DLP service on loopback
      -> act on the verdict

  Actions:
    block       reject with 550 at SMTP time
    quarantine  add X-DLP-Action: quarantine; Postfix header_checks turns that
                into HOLD, so the message lands in the hold queue for an admin
                to release with `postsuper -H`. No custom quarantine store
                needed — Postfix already has one.
    tag         add X-DLP-* headers and carry on (monitor mode's output)
    defer       451, retry later. This is what a failure looks like: closed.

  Install:
    cp dlp.lua /etc/rspamd/plugins/dlp.lua
    cp dlp.conf /etc/rspamd/local.d/dlp.conf
    systemctl restart rspamd
]]--

local rspamd_http = require "rspamd_http"
local rspamd_logger = require "rspamd_logger"
local lua_util = require "lua_util"

local N = "dlp"

local settings = {
  enabled = true,
  url = "http://127.0.0.1:11333/inspect",
  timeout = 10.0,
  -- Messages above this are not sent to the service; see on_oversize.
  max_size = 50 * 1024 * 1024,
  -- What to do when the service is unreachable, times out, or the message is
  -- too large. "defer" fails closed (correct for a compliance control);
  -- "allow" fails open (only for a monitoring-only pilot).
  on_error = "defer",
  on_oversize = "defer",
  -- Only inspect authenticated submission by default: this is an *outbound*
  -- control, and scanning inbound internet mail here doubles the work for no
  -- benefit.
  authenticated_only = true,
  -- Symbol inserted so the verdict shows up in Rspamd history/logs.
  symbol = "DLP_MATCH",
}

local function envelope_headers(task)
  local from = task:get_from("smtp")
  local sender = (from and from[1] and from[1].addr) or ""

  local rcpts = {}
  local recipients = task:get_recipients("smtp") or {}
  for _, r in ipairs(recipients) do
    if r.addr then table.insert(rcpts, r.addr) end
  end

  -- Tenant = the sending domain. The service falls back to this too, but
  -- sending it explicitly keeps audit records right when a relay rewrites
  -- the envelope sender.
  local tenant = ""
  if from and from[1] and from[1].domain then
    tenant = from[1].domain:lower()
  end

  local ip = task:get_from_ip()

  return {
    ["Content-Type"] = "message/rfc822",
    ["X-DLP-Sender"] = sender,
    ["X-DLP-Rcpt"] = table.concat(rcpts, ","),
    ["X-DLP-Tenant"] = tenant,
    ["X-DLP-Queue-Id"] = task:get_queue_id() or "",
    ["X-DLP-Message-Id"] = task:get_message_id() or "",
    ["X-DLP-Client-Ip"] = (ip and ip:to_string()) or "",
  }
end

local function apply_headers(task, headers)
  if not headers then return end
  for name, value in pairs(headers) do
    task:set_milter_reply({
      add_headers = { [name] = { order = 0, value = tostring(value) } }
    })
  end
end

local function fail(task, why, how)
  rspamd_logger.errx(task, "DLP %s: %s", how, why)
  if how == "defer" then
    task:set_pre_result("soft reject",
      "451 4.7.1 Data loss prevention check unavailable, please retry", N)
  else
    -- Failing open: record it loudly so the gap is visible in the audit trail.
    task:insert_result("DLP_FAIL_OPEN", 0.0, why)
    apply_headers(task, { ["X-DLP-Action"] = "not-inspected",
                          ["X-DLP-Error"] = tostring(why) })
  end
end

local function on_verdict(task, err, code, body)
  if err then
    return fail(task, tostring(err), settings.on_error)
  end
  if code ~= 200 then
    return fail(task, string.format("service returned HTTP %s", tostring(code)),
                settings.on_error)
  end

  local parser = require "ucl".parser()
  local ok, perr = parser:parse_string(body or "")
  if not ok then
    return fail(task, "unparseable verdict: " .. tostring(perr), settings.on_error)
  end
  local v = parser:get_object()
  if not v or not v.action then
    return fail(task, "verdict has no action", settings.on_error)
  end

  local score = tonumber(v.score) or 0.0
  local action = tostring(v.action)
  local incident = tostring(v.incident_id or "-")

  rspamd_logger.infox(task, "DLP %s action=%s score=%.1f mode=%s",
    incident, action, score, tostring(v.mode or "?"))

  -- Always stamp the headers: in monitor mode they are the entire product,
  -- and in enforce mode they are what the hold queue is matched on.
  apply_headers(task, v.headers)

  if score > 0 then
    task:insert_result(settings.symbol, 0.0,
      string.format("%s:%s:%.1f", incident, action, score))
  end

  if action == "block" then
    task:set_pre_result("reject",
      v.smtp_response or
      ("550 5.7.1 Message blocked by data loss prevention policy, id " .. incident),
      N)
  elseif action == "defer" then
    task:set_pre_result("soft reject",
      v.smtp_response or "451 4.7.1 Please retry", N)
  end
  -- "quarantine" and "tag" need nothing further here: the X-DLP-Action header
  -- is already set, and Postfix header_checks turns quarantine into HOLD.
end

local function dlp_check(task)
  if not settings.enabled then return end

  if settings.authenticated_only and not task:get_user() then
    lua_util.debugm(N, task, "skipping: not authenticated submission")
    return
  end

  if task:has_flag("skip") then return end

  local size = task:get_size()
  if size > settings.max_size then
    return fail(task,
      string.format("message is %d bytes, above max_size", size),
      settings.on_oversize)
  end

  local ok, err = rspamd_http.request({
    task = task,
    url = settings.url,
    body = task:get_content(),
    headers = envelope_headers(task),
    timeout = settings.timeout,
    callback = function(e, code, body) on_verdict(task, e, code, body) end,
  })

  if not ok then
    return fail(task, "could not queue request: " .. tostring(err),
                settings.on_error)
  end
end

-- ---------------------------------------------------------------------------
-- registration
-- ---------------------------------------------------------------------------

local opts = rspamd_config:get_all_opt(N)
if opts then
  settings = lua_util.override_defaults(settings, opts)
end

if not settings.enabled then
  rspamd_logger.infox(rspamd_config, "DLP plugin disabled by configuration")
  return
end

local id = rspamd_config:register_symbol({
  name = settings.symbol,
  type = "prefilter",
  priority = 10,
  callback = dlp_check,
  -- 0 weight: DLP decides with pre_result, it must not merely nudge the spam
  -- score. A compliance control that only adds 3 points is not a control.
  score = 0.0,
  group = N,
})

rspamd_config:register_symbol({
  name = "DLP_FAIL_OPEN",
  type = "virtual",
  parent = id,
  score = 0.0,
  group = N,
})

rspamd_logger.infox(rspamd_config, "DLP plugin registered: url=%s on_error=%s",
  settings.url, settings.on_error)
