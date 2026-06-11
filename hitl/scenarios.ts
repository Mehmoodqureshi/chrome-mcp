/** Default HITL scenarios, parameterized by the test targets. */

import type { Scenario, Targets } from './types';

export function defaultScenarios(targets: Targets): Scenario[] {
  const scenarios: Scenario[] = [
    { name: 'get_text', tool: 'get_text', args: {}, mutating: false, description: 'read visible page text' },
    { name: 'read_as_markdown', tool: 'read_as_markdown', args: {}, mutating: false, description: 'page → markdown' },
    { name: 'extract_links', tool: 'extract_links', args: { sameOriginOnly: true }, mutating: false, description: 'same-origin links' },
    { name: 'screenshot', tool: 'screenshot', args: {}, mutating: false, description: 'capture a screenshot' },
  ];

  if (targets.formFields && Object.keys(targets.formFields).length > 0) {
    scenarios.push({
      name: 'fill_form',
      tool: 'fill_form',
      args: { fields: targets.formFields, submitSelector: targets.submitSelector },
      mutating: true,
      description: 'fill (and optionally submit) a form',
    });
  }

  return scenarios;
}
