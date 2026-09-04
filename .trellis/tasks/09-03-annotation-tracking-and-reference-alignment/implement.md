# 执行计划

## 顺序清单

### 1. 建立轨迹领域函数和契约

- [x] 补齐 `AnnotationRecord` schema 对属性、`trackId`、`keyframe`、`provenance` 和错误标记字段的保留。
- [x] 新增纯轨迹工具，定义帧排序、轨迹分组、关键帧查找、矩形/多边形/折线/关键点/八点长方体插值和拓扑不兼容结果。
- [x] 为轨迹工具增加单元测试，先覆盖单关键帧、双关键帧、中间帧、多个对象、方向切换、点数变化和边界坐标。

验证：`npm test -- --run src/components/annotation/annotationTracks.test.ts shared`（按实际 Vitest 文件调整）。

### 2. 接入工作台追踪模式

- [x] 在当前工具配置弹窗中增加参考平台同款“绘制/追踪”选择，覆盖矩形、多边形、折线、点、长方体。
- [x] 创建轨迹首关键帧并为 Job 帧草稿补齐轨迹记录；所有生成操作必须合并已有无关标注。
- [x] 实现关键帧编辑、`K` 切换、关键帧前后导航、轨迹对象显示和中间帧手动修正。
- [x] 将 `Ctrl+B` 从仅复制下一帧改为跨 Job 帧集合复制当前对象，保留已有对象并使用 `copied` 来源。
- [x] 保存轨迹涉及的所有 dirty 帧，沿用现有 revision、审核锁、末帧提交限制和失败重试。

验证：组件测试覆盖选择追踪、创建轨迹、切帧可见、关键帧更新、刷新恢复和保存失败；运行 `npm test -- --run src/pages/AnnotationPage.test.tsx`。

### 3. 对齐现有按钮真实行为

- [x] “标记为错”改为设置/取消对象错误状态，Issues 面板显示被标记对象，禁止删除对象。
- [x] 实现工作区选择器，确保当前入口可打开并可切换受支持模式。
- [x] 将标签工具接入图像标签保存；将设置弹窗接入现有画布显示状态。
- [x] 补齐播放栏跳帧控件和轨迹关键帧导航，确认播放不覆盖未保存草稿。
- [x] 清理快捷键弹窗中的未实现合并/分割声明，解决 `M` 移动画布与轨迹关键帧导航的冲突。
- [x] 保持返回数据中心、用户菜单退出、全屏、标注信息、保存/审核按钮可操作。

验证：逐项使用组件测试点击按钮并断言状态/API payload；对照参考平台工作台控件清单复核。

### 4. 后端和归属验证

- [x] 增加 API/仓储测试，验证轨迹字段经过保存和读取不丢失。
- [x] 验证审核员保存轨迹修改仍产生既有 before/after 审计，且标注员原始标注量与审核员修改量区分不变。
- [x] 验证旧的无轨迹 annotation document、普通图片任务和未使用追踪模式的逐帧保存行为不变。

验证：`npm run typecheck:server`、`npm test -- --run server/api.test.ts server/repository.test.ts server/annotationAttribution.test.ts`。

### 5. 质量门禁和发布前检查

- [x] 运行完整类型检查、测试和构建。
- [x] 运行已有 Playwright 标注流程，至少验证工具选择持久、播放、保存、末帧提交限制、审核退出和返回数据中心。
- [x] 使用视频任务验证追踪创建、关键帧修改、中间帧显示、刷新恢复和提交。
- [x] 检查桌面和窄屏布局，确认追踪弹窗、对象状态和提示不遮挡画布。

验证命令：

```bash
npm run typecheck
npm run typecheck:server
npm test
npm run build
npm run test:e2e
```

## 高风险文件

- `src/components/annotation/ReferenceAnnotationWorkbench.tsx`：状态、帧切换、保存、键盘和绘制事件集中，优先用纯函数降低改动风险。
- `src/components/annotation/annotationTracks.ts`：几何插值错误会直接污染多帧结果，必须先测后接入。
- `shared/schemas.ts`：字段未声明会导致 Zod 静默剥离轨迹元数据，需用 API 测试验证实际 payload。
- `server/repository.ts`：审核锁和 revision 规则不能因轨迹批量更新被绕过。

## 回滚点

1. 轨迹纯函数测试通过后再接入工作台；失败时只回滚该模块接入，不动普通绘制。
2. 追踪入口和跨帧复制完成后再调整按钮行为；按钮改动失败时保留已有逐帧标注。
3. 全量测试通过前不更改部署端口或服务配置。
