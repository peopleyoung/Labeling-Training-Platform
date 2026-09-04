# 技术设计

## 方案

将当前 `src/pages/AnnotationPage.tsx` 降级为路由兼容层，新增独立的参考平台工作台模块。页面层负责 Job 数据加载、权限和业务动作；工作台组件负责参考平台交互状态；序列化适配器负责当前项目 `AnnotationDocument` 与参考平台 Shape 语义之间的转换。

## 模块边界

- `src/pages/AnnotationPage.tsx`：保持路由入口，组装 Job 上下文，不再承载完整绘制状态机。
- `src/components/annotation/ReferenceAnnotationWorkbench.tsx`：顶栏、状态栏、画布、工具栏、帧导航、对象区和面板布局。
- `src/components/annotation/annotationState.ts`：工具状态、选中状态、绘制会话、撤销/重做和不可变快照。
- `src/components/annotation/annotationGeometry.ts`：像素/视口坐标转换、矩形控制点、多边形/折线点列、立方体投影和命中测试。
- `src/components/annotation/annotationShortcuts.ts`：快捷键注册、优先级、输入控件过滤和测试用映射。
- `src/components/annotation/annotationSerialization.ts`：CVAT 形状语义与当前项目 `AnnotationRecord` 的边界转换。
- `src/styles.css` 或工作台专用样式：按参考平台区域固定尺寸、间距、层级和状态样式，避免状态文案改变网格尺寸。

## 状态模型

编辑器状态分为四层：

1. Job/Segment 服务器事实：只读输入，来自当前项目 API。
2. 当前帧文档：服务端 revision、标注对象、属性和审核状态。
3. 编辑会话：当前工具、绘制草稿、选中对象、拖动会话、视口和面板。
4. 保存队列：以 imageId 为键的不可变快照，保存请求带 revision；请求返回后按快照身份判断是否可以回写。

保存过程中如果当前帧产生新编辑，只更新 revision/服务器状态，不覆盖本地几何；新快照继续保持 dirty 并由防抖保存提交。

## 参考平台交互对齐

- 以浏览器实际 DOM 和事件序列为准，不以当前工具名称或已有测试假设为准。
- 多点工具统一使用 pointer/click 事件状态机，明确单击加点、双击完成、右键/Escape 取消、Enter 完成和切换工具清理草稿的优先级。
- 画布采用稳定的外框比例和内部 viewport 变换；媒体加载、缩放和旋转只变换内部层，不改变工作台布局流。
- 对象渲染统一使用参考平台的选中描边、控制点半径、填充透明度和 z-order；业务属性面板不改变画布几何。

## 风险与回滚

- 新工作台在核心测试通过前保留旧路由兼容，但不再继续扩展旧编辑器。
- 若某个高级工具缺少实测证据，先实现工具壳和明确禁用态，不伪造数据格式或交互结果。
- 后端接口和训练快照不迁移；回滚只切换前端 Job 工作台入口，避免影响已保存标注和训练数据。
