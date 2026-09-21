# XSOAR DOM source contract

The assistant extracts incident data only from the configured HTTPS XSOAR origin and incident route. Production captures must never be committed as fixtures because they can contain incident identifiers, tenant details, addresses, URLs, and event payloads. Tests use fictional, synthetic DOM structures.

## Stable incident-field sources

- `.field-wrapper` scopes a displayed incident field.
- `fieldId-*` classes provide the highest-confidence field identity.
- `.text-field-display-value`, `.date-display-value`, `.single-select-field-wrapper__single-value`, `[class*="singleValue"]`, `.markdown`, and `.preplacer` provide visible values inside a field scope.
- The configured field-label aliases remain the fallback for labelled wrappers and two-column display tables.

Dynamic Angular `ng-*` attributes, generated CSS class names, UUIDs, and arbitrary whole-page text are not selector contracts.

## Detailed alert sources

The supported XSOAR layout renders detailed evidence as two named sections:

- `h3` with exact visible text `JSON Events`
- `h3` with exact visible text `Source Events`

In the verified layout, each heading and its table share a parent element. The source table is the first descendant `table` of that parent. A supported detailed-event table has visible data rows containing exactly two `td` cells: the event key and its value. The extractor requires both named sections, reconstructs one object per section, and parses a value as nested JSON only when the complete value is valid JSON.

The extractor deliberately rejects arbitrary `td` elements, unrelated multi-column tables, hidden elements, and page-wide JSON-looking text. Explicit JSON widgets remain supported only through bounded JSON-labelled containers and incident-field-scoped renderers.

## Incident views and tabs

- Incident Info and Investigation tabs are discovered through `a[role="tab"][href]`.
- `.tab-label` supplies the preferred visible tab label, with anchor text as the fallback.
- `data-test-id="tabs-container"` and `data-test-id="investigation"` are known stable structural markers, but navigation continues to require a same-origin trusted incident URL.

## Historic incident search

- The incidents page is opened at the configured same-origin `incidentsPath` without a query string.
- The historic query is entered through the visible Incidents-page query bar within the workspace containing the results grid. Candidate controls are ranked by query/search semantics and existing query syntax; ambiguous matches fail closed.
- `.header-search`, `.r-header-actions-container`, and launcher search controls are explicitly excluded. The top-right `Search in Incidents` box is a global search box, not the Incidents-page query bar.
- Playwright fills that input and presses Enter so XSOAR's own event handlers update the search state.
- The configured query parameter is checked only after submission to confirm XSOAR applied the exact query. Setting the URL parameter directly is not supported because XSOAR can overwrite it from the main search control's state.
- Results remain scoped to the configured same-origin incidents path and same-origin incident links.

## Readiness and completeness

- Local AI processing requires at least one complete reconstructed alert document.
- A named event section without a usable two-column table is incomplete.
- Candidate, row, document-size, parse, and complexity limits fail closed to the deterministic source-field response.
- Historic results are incomplete when XSOAR paging reports more rows than the extractor reached or uses an unrecognised non-empty format; the analyst receives a warning rather than a false complete result.
