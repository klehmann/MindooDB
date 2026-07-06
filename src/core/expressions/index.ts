// The MindooDB expression language (formerly `mindoodb-view-language`):
// JSON-serializable expression AST, typed TypeScript builder, textual
// formula parser/formatter, helper metadata, and the runtime evaluator.
//
// The view-tree builder of the old package did not move — summary-backed
// ephemeral VirtualViews (`db.queryView()`) supersede it.

export * from "./types";
export { createViewLanguage } from "./builder";
export type { MindooDBAppFieldPath, MindooDBAppPathValue, MindooDBAppExpressionInput } from "./builder";
export {
  formatMindooDBFormulaExpression,
  isMindooDBFormulaLikelyBoolean,
  MindooDBFormulaSyntaxError,
  parseMindooDBFormulaBooleanExpression,
  parseMindooDBFormulaExpression,
} from "./formulaSource";
export {
  getMindooDBViewLanguageHelper,
  mindooDBViewLanguageHelpers,
  mindooDBViewLanguageHelpersByName,
} from "./metadata";
export type {
  MindooDBViewLanguageArgumentKind,
  MindooDBViewLanguageHelperArgument,
  MindooDBViewLanguageHelperCategory,
  MindooDBViewLanguageHelperMetadata,
} from "./metadata";
export {
  evaluateExpression,
  collectDecryptRequests,
  getReferencedFields,
  analyzeExpressionRequirements,
  getFieldValue,
  expressionToBoolean,
  expressionToNumber,
  VIEW_CONTEXT_OPERATIONS,
  type ExpressionEvaluationContext,
  type ExpressionViewRowCounts,
  type DecryptRequest,
} from "./evaluateExpression";
