/** Compatibility entry for Listing's existing imports. The reader itself lives in the shared
 *  platform-workbook package so business plugins never import each other's source. */
export { Workbook, WorkbookError as ListingError, validateRegion } from '../../../packages/platform-workbook/src/index.js';
export type { Sheet, Region, Cell, AlsSheetCell, AlsSheetContent } from '../../../packages/platform-workbook/src/index.js';