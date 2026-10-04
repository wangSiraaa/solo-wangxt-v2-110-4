/** 裁决标签：验证流水线与覆盖审阅共用（独立成模块，避免观察链路引入 HTTP 客户端）。 */
export const VERDICT_LABEL = {
  ok: '通过',
  redirect_loop: '重定向环',
  chain_too_long: '跳转链过长',
  fetch_error: '请求被拒/失败',
  deleted_gone_ok: '已删除-状态正确',
  deleted_not_gone: '已删除但未消亡',
  ambiguity: '归一化歧义',
  final_status_bad: '最终页状态异常',
};
