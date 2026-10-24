const schemas = { 'dead-code': 10, architecture: 1 };
const measuredCategories = [
  "unused_files",
  "unused_exports",
  "unused_types",
  "private_type_leaks",
  "deprecated_exports_in_use",
  "unused_dependencies",
  "unused_enum_members",
  "unused_class_members",
  "unused_store_members",
  "unprovided_injects",
  "unrendered_components",
  "unused_component_props",
  "absent_component_props",
  "unused_component_emits",
  "unused_component_inputs",
  "unused_component_outputs",
  "unused_svelte_events",
  "unused_server_actions",
  "unused_load_data_keys",
  "unresolved_imports",
  "unlisted_dependencies",
  "duplicate_exports",
  "type_only_dependencies",
  "test_only_dependencies",
  "dev_dependencies_in_production",
  "circular_dependencies",
  "re_export_cycles",
  "package_cycles",
  "boundary_violations",
  "boundary_coverage_violations",
  "boundary_call_violations",
  "policy_violations",
  "stale_suppressions",
  "unused_catalog_entries",
  "empty_catalog_groups",
  "unresolved_catalog_references",
  "unused_dependency_overrides",
  "misconfigured_dependency_overrides",
  "invalid_client_exports",
  "mixed_client_server_barrels",
  "misplaced_directives",
  "route_collisions",
  "dynamic_segment_name_conflicts",
];
const arrayCategories = [
  "unused_files",
  "unused_exports",
  "unused_types",
  "private_type_leaks",
  "deprecated_exports_in_use",
  "unused_dependencies",
  "unused_enum_members",
  "unused_class_members",
  "unresolved_imports",
  "unlisted_dependencies",
  "duplicate_exports",
  "type_only_dependencies",
  "test_only_dependencies",
  "dev_dependencies_in_production",
  "circular_dependencies",
  "re_export_cycles",
  "package_cycles",
  "boundary_violations",
  "boundary_coverage_violations",
  "boundary_call_violations",
  "policy_violations",
  "stale_suppressions",
  "unused_catalog_entries",
  "empty_catalog_groups",
  "unresolved_catalog_references",
  "unused_dependency_overrides",
  "misconfigured_dependency_overrides",
  "invalid_client_exports",
  "mixed_client_server_barrels",
  "misplaced_directives",
  "route_collisions",
  "dynamic_segment_name_conflicts",
];

/** Analysis output is a contract: malformed or partial reports cannot become a passing gate. */
export function assertFallowReport(report, kind) {
  if (!Object.hasOwn(schemas, kind) || !report || report.kind !== kind || report.schema_version !== schemas[kind] || report.version !== '3.35.0' ||
      !Number.isSafeInteger(report.total_issues) || report.total_issues < 0 || !report.summary || typeof report.summary !== 'object' ||
      Array.isArray(report.summary) || report.summary.total_issues !== report.total_issues || report.workspace_diagnostics !== undefined && !Array.isArray(report.workspace_diagnostics))
    throw Error('Fallow returned an unsupported or incomplete report.');
  for (const category of measuredCategories) if (!Object.hasOwn(report.summary, category)) throw Error('Fallow omitted a measured category: ' + category);
  for (const category of arrayCategories) if (!Array.isArray(report[category])) throw Error('Fallow omitted findings: ' + category);
  let total = 0;
  for (const [category, count] of Object.entries(report.summary)) {
    if (!Number.isSafeInteger(count) || count < 0) throw Error('Invalid Fallow finding count: ' + category);
    if (category === 'total_issues') continue;
    total += count;
    if ((count > 0 || Object.hasOwn(report, category)) && (!Array.isArray(report[category]) || report[category].length !== count))
      throw Error('Incomplete Fallow findings: ' + category);
  }
  if (total !== report.total_issues) throw Error('Fallow finding totals do not match its categories.');
  for (const diagnostic of report.workspace_diagnostics ?? []) {
    if (!diagnostic || typeof diagnostic.kind !== 'string' || typeof diagnostic.message !== 'string' || diagnostic.degrades_analysis)
      throw Error('Fallow source analysis is incomplete. Inspect the full report.');
  }
  return report;
}
