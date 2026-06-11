/** Shared types for the human-in-the-loop harness. */

export interface Scenario {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  /** True for anything that changes browser state (navigate/click/type/download…). */
  mutating: boolean;
  description?: string;
}

export interface Targets {
  /** The page the run navigates to first. Must be within `allowDomains`. */
  baseUrl: string;
  /** Domain allowlist handed to the policy. */
  allowDomains: string[];
  /** Optional selector→value map for the fill_form scenario. */
  formFields?: Record<string, string>;
  /** Optional submit selector for fill_form. */
  submitSelector?: string;
}

export interface RunOptions {
  includeMutating: boolean;
  headless: boolean;
}
