/**
 * src/mcp/tool-categories.ts — which group each tool belongs to.
 *
 * The same grouping as the website's tool reference, sent with each call as
 * `$mcp_tool_category` so PostHog's MCP Analytics can be filtered by group
 * (reading vs interaction vs navigation...). Our own labels, no user data.
 */

export const TOOL_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  tabs_list: 'tabs',
  tab_new: 'tabs',
  tab_select: 'tabs',
  tab_close: 'tabs',
  navigate: 'navigation',
  back: 'navigation',
  forward: 'navigation',
  reload: 'navigation',
  wait_for: 'navigation',
  click: 'interaction',
  type: 'interaction',
  select_option: 'interaction',
  press: 'interaction',
  hover: 'interaction',
  scroll: 'interaction',
  fill_form: 'interaction',
  upload_file: 'interaction',
  snapshot: 'reading',
  get_text: 'reading',
  read_as_markdown: 'reading',
  get_html: 'reading',
  extract_links: 'reading',
  screenshot: 'reading',
  print_pdf: 'reading',
  frames_list: 'reading',
  get_cookies: 'state',
  storage: 'state',
  download_file: 'state',
  eval: 'state',
  console_logs: 'observers',
  network_log: 'observers',
  dialogs: 'observers',
  chrome_status: 'session',
  auth_check: 'session',
  profile_use: 'session',
  profile_rename: 'session',
  task_new: 'session',
  tasks_list: 'session',
  task_status: 'session',
  batch: 'batch',
});
