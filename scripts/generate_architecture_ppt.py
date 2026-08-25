"""Generate an editable Chinese system-architecture presentation for Forge AI.

The project intentionally has no runtime presentation dependency. This script
writes a small, standards-compliant OOXML package with native PowerPoint
shapes, text boxes, connectors, and tables so the resulting diagrams remain
editable after opening in PowerPoint or LibreOffice.
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


OUT = Path(__file__).resolve().parents[1] / "docs" / "Forge-AI-系统架构说明.pptx"

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
}
for prefix, uri in NS.items():
    ET.register_namespace(prefix if prefix != "rel" and prefix != "ct" else "", uri)

EMU = 914400
SW, SH = 13.333 * EMU, 7.5 * EMU

COLORS = {
    "navy": "081B2B",
    "navy2": "0D2940",
    "blue": "1685E8",
    "cyan": "42D7E8",
    "teal": "20B8A5",
    "violet": "8066E8",
    "orange": "F39A45",
    "red": "EC6672",
    "ink": "13283A",
    "muted": "668095",
    "line": "D7E2EA",
    "paper": "F4F8FB",
    "white": "FFFFFF",
    "paleBlue": "E8F3FF",
    "paleCyan": "E7FBFD",
    "paleTeal": "E8F8F4",
    "paleOrange": "FFF2E4",
    "paleViolet": "F1EDFF",
}


def tag(parent: ET.Element, name: str, attrs: dict[str, str] | None = None) -> ET.Element:
    node = ET.SubElement(parent, name, attrs or {})
    return node


def declare_namespaces(root: ET.Element, *prefixes: str) -> None:
    """Add explicit namespace declarations for the hand-authored OOXML tags."""
    for prefix in prefixes:
        root.set(f"xmlns:{prefix}", NS[prefix])


def xfrm(parent: ET.Element, x: float, y: float, w: float, h: float) -> None:
    off = tag(parent, "a:off", {"x": str(int(x * EMU)), "y": str(int(y * EMU))})
    tag(parent, "a:ext", {"cx": str(int(w * EMU)), "cy": str(int(h * EMU))})


def color(parent: ET.Element, value: str) -> None:
    tag(parent, "a:srgbClr", {"val": value})


def fill(parent: ET.Element, value: str | None, transparency: int = 0) -> None:
    if value is None:
        tag(parent, "a:noFill")
        return
    solid = tag(parent, "a:solidFill")
    clr = tag(solid, "a:srgbClr", {"val": value})
    if transparency:
        tag(clr, "a:alpha", {"val": str(100000 - transparency * 1000)})


def line(parent: ET.Element, value: str | None, width: int = 1, dash: str | None = None) -> None:
    ln = tag(parent, "a:ln", {"w": str(width * 12700)})
    if value:
        solid = tag(ln, "a:solidFill")
        color(solid, value)
    else:
        tag(ln, "a:noFill")
    if dash:
        tag(ln, "a:prstDash", {"val": dash})


def text_body(parent: ET.Element, lines: list[tuple[str, int, str, bool, str]], margin: int = 100, valign: str = "ctr") -> None:
    body = tag(parent, "p:txBody")
    body_pr = tag(body, "a:bodyPr", {"lIns": str(margin), "rIns": str(margin), "tIns": str(margin), "bIns": str(margin), "vert": "horz"})
    tag(body_pr, "a:noAutofit")
    tag(body, "a:lstStyle")
    for text, size, clr, bold, align in lines:
        para = tag(body, "a:p")
        ppr = tag(para, "a:pPr", {"algn": align, "marL": "0", "indent": "0"})
        tag(ppr, "a:defRPr")
        parts = text.split("\n")
        for part_index, part in enumerate(parts):
            if part_index:
                tag(para, "a:br")
            run = tag(para, "a:r")
            rpr = tag(run, "a:rPr", {"lang": "zh-CN", "sz": str(size), "b": "1" if bold else "0"})
            tag(rpr, "a:latin", {"typeface": "Aptos"})
            tag(rpr, "a:ea", {"typeface": "Noto Sans CJK SC"})
            solid = tag(rpr, "a:solidFill")
            color(solid, clr)
            tag(run, "a:t").text = part
        tag(para, "a:endParaRPr", {"lang": "zh-CN", "sz": str(size)})
    tag(body, "a:extLst")


class Slide:
    def __init__(self, number: int, title: str, section: str, dark: bool = False):
        self.number = number
        self.title = title
        self.section = section
        self.dark = dark
        self.root = ET.Element("p:sld")
        declare_namespaces(self.root, "a", "p", "r")
        self.cSld = tag(self.root, "p:cSld")
        self.spTree = tag(self.cSld, "p:spTree")
        # The non-visual group properties are required before child shapes in
        # the PresentationML shape tree. Keeping them explicit also makes the
        # package open cleanly in PowerPoint and LibreOffice.
        group_nv = tag(self.spTree, "p:nvGrpSpPr")
        tag(group_nv, "p:cNvPr", {"id": "1", "name": ""})
        tag(group_nv, "p:cNvGrpSpPr")
        tag(group_nv, "p:nvPr")
        group_pr = tag(self.spTree, "p:grpSpPr")
        group_xfrm = tag(group_pr, "a:xfrm")
        xfrm(group_xfrm, 0, 0, 0, 0)
        tag(group_xfrm, "a:chOff", {"x": "0", "y": "0"})
        tag(group_xfrm, "a:chExt", {"cx": "0", "cy": "0"})
        self.shape_id = 1
        self.background(COLORS["navy"] if dark else COLORS["paper"])
        tag(self.root, "p:clrMapOvr")
        tag(self.root[-1], "a:masterClrMapping")

    def next_id(self) -> int:
        self.shape_id += 1
        return self.shape_id

    def background(self, value: str) -> None:
        sp = tag(self.spTree, "p:sp")
        nv = tag(sp, "p:nvSpPr")
        tag(nv, "p:cNvPr", {"id": str(self.next_id()), "name": "Background"})
        tag(nv, "p:cNvSpPr")
        tag(nv, "p:nvPr")
        sppr = tag(sp, "p:spPr")
        x = tag(sppr, "a:xfrm")
        xfrm(x, 0, 0, 13.333, 7.5)
        geom = tag(sppr, "a:prstGeom", {"prst": "rect"})
        tag(geom, "a:avLst")
        fill(sppr, value)
        line(sppr, None)

    def shape(self, x: float, y: float, w: float, h: float, *, text: list[tuple[str, int, str, bool, str]] | None = None, fill_color: str | None = None, line_color: str | None = COLORS["line"], radius: bool = False, line_width: int = 1, name: str = "Shape", margin: int = 120) -> None:
        sp = tag(self.spTree, "p:sp")
        nv = tag(sp, "p:nvSpPr")
        tag(nv, "p:cNvPr", {"id": str(self.next_id()), "name": name})
        tag(nv, "p:cNvSpPr")
        tag(nv, "p:nvPr")
        sppr = tag(sp, "p:spPr")
        tr = tag(sppr, "a:xfrm")
        xfrm(tr, x, y, w, h)
        geom = tag(sppr, "a:prstGeom", {"prst": "roundRect" if radius else "rect"})
        tag(geom, "a:avLst")
        fill(sppr, fill_color)
        line(sppr, line_color, line_width)
        if text:
            text_body(sp, text, margin=margin)

    def text(self, x: float, y: float, w: float, h: float, value: str, size: int = 16, clr: str | None = None, bold: bool = False, align: str = "l", margin: int = 0) -> None:
        self.shape(x, y, w, h, text=[(value, size, clr or (COLORS["white"] if self.dark else COLORS["ink"]), bold, align)], fill_color=None, line_color=None, name=f"Text {value[:12]}", margin=margin)

    def card(self, x: float, y: float, w: float, h: float, title: str, body: str, accent: str = "blue", icon: str | None = None, dark: bool = False) -> None:
        bg = COLORS["navy2"] if dark else COLORS["white"]
        title_color = COLORS["white"] if dark else COLORS["ink"]
        body_color = "B8D0DE" if dark else COLORS["muted"]
        self.shape(x, y, w, h, fill_color=bg, line_color=COLORS[accent], radius=True, line_width=2, name=title)
        self.shape(x, y, 0.075, h, fill_color=COLORS[accent], line_color=None, radius=True, name=f"{title} accent")
        if icon:
            self.shape(x + 0.22, y + 0.22, 0.38, 0.38, text=[(icon, 16, COLORS[accent], True, "ctr")], fill_color=COLORS["white"] if not dark else COLORS["navy"], line_color=None, radius=True, name=f"{title} icon")
            tx = x + 0.72
        else:
            tx = x + 0.24
        if h < 0.9:
            # Compact cards are used for diagram labels and footer callouts;
            # keep both text runs inside the short shape instead of applying
            # the two-line layout used by full-size cards.
            self.text(tx, y + 0.1, w - (tx - x) - 0.15, 0.18, title, 8 if h < 0.6 else 9, title_color, True)
            self.text(tx, y + 0.3, w - (tx - x) - 0.15, max(0.12, h - 0.34), body, 7, body_color, False)
            return
        self.text(tx, y + 0.2, w - (tx - x) - 0.15, 0.35, title, 15, title_color, True)
        self.text(tx, y + 0.65, w - (tx - x) - 0.18, h - 0.8, body, 10, body_color, False)

    def pill(self, x: float, y: float, w: float, label: str, color_name: str, dark: bool = False) -> None:
        self.shape(x, y, w, 0.3, text=[(label, 9, COLORS[color_name], True, "ctr")], fill_color=COLORS["navy2"] if dark else COLORS["white"], line_color=COLORS[color_name], radius=True, name=label)

    def arrow(self, x1: float, y1: float, x2: float, y2: float, clr: str = "blue", width: int = 2, dashed: bool = False) -> None:
        sp = tag(self.spTree, "p:cxnSp")
        nv = tag(sp, "p:nvCxnSpPr")
        tag(nv, "p:cNvPr", {"id": str(self.next_id()), "name": "Connector"})
        tag(nv, "p:cNvCxnSpPr")
        tag(nv, "p:nvPr")
        sppr = tag(sp, "p:spPr")
        tr = tag(sppr, "a:xfrm")
        xfrm(tr, min(x1, x2), min(y1, y2), abs(x2 - x1) or 0.02, abs(y2 - y1) or 0.02)
        geom = tag(sppr, "a:prstGeom", {"prst": "line"})
        tag(geom, "a:avLst")
        ln = tag(sppr, "a:ln", {"w": str(width * 12700)})
        solid = tag(ln, "a:solidFill")
        color(solid, COLORS[clr])
        if dashed:
            tag(ln, "a:prstDash", {"val": "dash"})
        tag(ln, "a:tailEnd", {"type": "none"})
        tag(ln, "a:headEnd", {"type": "triangle", "w": "med", "len": "med"})

    def header(self, kicker: str | None = None) -> None:
        if self.dark:
            self.shape(0.5, 0.34, 0.58, 0.08, fill_color=COLORS["cyan"], line_color=None, name="Header accent")
            self.text(0.5, 0.6, 11.8, 0.65, self.title, 27, COLORS["white"], True)
            self.text(0.5, 1.28, 11.8, 0.32, kicker or self.section, 11, "B8D0DE")
        else:
            self.shape(0.5, 0.34, 0.58, 0.08, fill_color=COLORS["blue"], line_color=None, name="Header accent")
            self.text(0.5, 0.6, 11.8, 0.65, self.title, 27, COLORS["ink"], True)
            self.text(0.5, 1.28, 11.8, 0.32, kicker or self.section, 11, COLORS["muted"])

    def footer(self) -> None:
        self.text(0.5, 7.13, 6.5, 0.18, "FORGE AI  ·  工业质检模型生产平台", 8, "8FA9B9" if self.dark else "7D95A5")
        self.text(12.2, 7.13, 0.6, 0.18, f"{self.number:02d}", 8, "8FA9B9" if self.dark else "7D95A5", False, "r")


def slide_1() -> Slide:
    s = Slide(1, "Forge AI 系统架构", "工业质检模型生产平台 · 设计理念与技术架构", dark=True)
    s.shape(0.7, 0.8, 0.12, 5.7, fill_color=COLORS["blue"], line_color=None, name="cover blue")
    s.shape(0.86, 0.8, 0.06, 3.5, fill_color=COLORS["cyan"], line_color=None, name="cover cyan")
    s.text(1.25, 1.12, 6.8, 0.32, "FORGE AI  /  SYSTEM ARCHITECTURE", 11, COLORS["cyan"], True)
    s.text(1.22, 1.75, 9.6, 1.35, "从数据到模型的\n工业质检生产闭环", 31, COLORS["white"], True)
    s.text(1.28, 3.43, 7.3, 0.65, "单租户 · 企业内网 · 可追溯 · CPU/GPU 双模式", 15, "B8D0DE")
    s.pill(1.28, 4.55, 1.55, "数据标注", "blue", True)
    s.pill(2.98, 4.55, 1.55, "真实训练", "teal", True)
    s.pill(4.68, 4.55, 1.55, "模型转换", "violet", True)
    s.pill(6.38, 4.55, 1.55, "部署交付", "orange", True)
    s.card(9.2, 1.25, 3.2, 1.24, "平台定位", "面向工业质检团队的模型生产工作台，统一承载数据、训练、模型和部署产物。", "cyan", "01", True)
    s.card(9.2, 2.78, 3.2, 1.24, "设计基线", "React + Fastify + PostgreSQL + Redis/BullMQ + Python Worker + Docker Compose。", "blue", "02", True)
    s.card(9.2, 4.31, 3.2, 1.24, "交付边界", "平台负责生产与制品治理；在线推理服务由外部 Runtime 按格式加载。", "orange", "03", True)
    s.footer()
    return s


def slide_2() -> Slide:
    s = Slide(2, "设计理念：把“训练脚本”产品化", "四个原则决定系统边界与演进方式")
    s.header("从一次性实验到可追溯的模型生产系统")
    cards = [
        (0.65, 2.0, "数据先行", "数据集是通用容器，任务类型在导出和训练阶段选择；标注、审核、版本与格式统一管理。", "blue", "01"),
        (3.88, 2.0, "异步解耦", "API 负责鉴权、校验、入队和查询；Worker 负责真实执行，长任务不阻塞业务请求。", "teal", "02"),
        (7.11, 2.0, "制品可追溯", "模型、转换文件、导出包都绑定来源任务、版本、哈希和审计记录，支持回滚与清理。", "violet", "03"),
        (10.34, 2.0, "能力可降级", "无 GPU 仍可完成数据、导出、CPU 训练和 CPU 安全格式转换；GPU 能力按配置开放。", "orange", "04"),
    ]
    for x, y, title, body, accent, num in cards:
        s.card(x, y, 2.65, 2.45, title, body, accent, num)
    s.shape(0.65, 5.05, 12.05, 0.85, fill_color=COLORS["navy2"], line_color=None, radius=True, name="principles bar")
    s.text(0.93, 5.27, 2.0, 0.25, "核心判断", 11, COLORS["cyan"], True)
    s.text(2.38, 5.22, 9.8, 0.32, "任何一次“创建、执行、转换、删除”，都必须能回答：谁做的、基于什么数据、生成了什么、现在在哪里。", 13, COLORS["white"], True)
    s.footer()
    return s


def slide_3() -> Slide:
    s = Slide(3, "总体架构：控制面与执行面分离", "Web/API 负责确定性，队列/Worker 负责弹性与算力")
    s.header("逻辑分层")
    # swim lanes
    s.shape(0.55, 1.9, 12.25, 1.02, fill_color=COLORS["paleBlue"], line_color=COLORS["line"], radius=True, name="experience lane")
    s.text(0.75, 2.15, 1.1, 0.22, "体验层", 11, COLORS["blue"], True)
    s.card(2.0, 2.03, 2.35, 0.73, "浏览器 / React", "工作台 · 标注 · 训练 · 仓库", "blue", None)
    s.card(4.85, 2.03, 2.35, 0.73, "ApiClient", "统一 DTO / 错误 / 会话", "cyan", None)
    s.card(7.7, 2.03, 2.35, 0.73, "Dashboard", "活动 · 状态 · 进度", "teal", None)
    s.arrow(4.35, 2.39, 4.8, 2.39, "blue")
    s.arrow(7.2, 2.39, 7.65, 2.39, "blue")

    s.shape(0.55, 3.15, 12.25, 1.18, fill_color=COLORS["white"], line_color=COLORS["line"], radius=True, name="control lane")
    s.text(0.75, 3.55, 1.1, 0.22, "控制面", 11, COLORS["ink"], True)
    s.card(2.0, 3.32, 2.35, 0.82, "Fastify API", "鉴权 · 校验 · 审计 · 查询", "blue", None)
    s.card(4.85, 3.32, 2.35, 0.82, "Repository", "PostgreSQL / 内存适配器", "violet", None)
    s.card(7.7, 3.32, 2.35, 0.82, "BullMQ Queue", "训练 · 转换 · 导出", "orange", None)
    s.arrow(4.35, 3.73, 4.8, 3.73, "blue")
    s.arrow(7.2, 3.73, 7.65, 3.73, "orange")

    s.shape(0.55, 4.55, 12.25, 1.45, fill_color=COLORS["navy2"], line_color=COLORS["navy2"], radius=True, name="execution lane")
    s.text(0.75, 5.08, 1.1, 0.22, "执行面", 11, COLORS["cyan"], True)
    s.card(2.0, 4.82, 2.2, 0.92, "CPU Worker", "YOLO · 分割 · 关键点\nONNX / TorchScript / OpenVINO", "teal", None, True)
    s.card(4.7, 4.82, 2.2, 0.92, "GPU Worker", "TensorRT · GPU 训练\nSDXL LoRA", "violet", None, True)
    s.card(7.4, 4.82, 2.2, 0.92, "Export Worker", "YOLO / COCO / VOC\nMask / Keypoints / Image Folder", "orange", None, True)
    s.card(10.1, 4.82, 2.2, 0.92, "Artifact Volume", "原图 · 权重 · ZIP · 转换产物", "blue", None, True)
    s.arrow(9.98, 3.73, 9.98, 4.75, "orange")
    s.arrow(9.6, 5.28, 10.05, 5.28, "cyan")
    s.footer()
    return s


def slide_4() -> Slide:
    s = Slide(4, "部署拓扑：企业内网单租户一体化", "Docker Compose 编排，数据面与算力面共享内部网络")
    s.header("生产部署基线：2 × NVIDIA T4 16G，可切换 CPU-only")
    s.shape(0.55, 1.85, 12.25, 4.65, fill_color=COLORS["white"], line_color=COLORS["line"], radius=True, name="LAN boundary")
    s.text(0.8, 2.03, 3.4, 0.25, "企业内网 / Docker Compose 边界", 12, COLORS["ink"], True)
    s.shape(0.85, 2.48, 2.15, 2.85, fill_color=COLORS["paleBlue"], line_color=COLORS["blue"], radius=True, name="user side")
    s.text(1.08, 2.72, 1.7, 0.25, "访问入口", 11, COLORS["blue"], True, "ctr")
    s.card(1.05, 3.2, 1.75, 0.75, "浏览器", "标注员 / 算法工程师 / 管理员", "blue", None)
    s.card(1.05, 4.2, 1.75, 0.75, "Web :5174", "静态前端与路由", "cyan", None)
    s.shape(3.35, 2.48, 3.05, 2.85, fill_color=COLORS["paleCyan"], line_color=COLORS["teal"], radius=True, name="control services")
    s.text(3.62, 2.72, 2.5, 0.25, "控制服务", 11, COLORS["teal"], True, "ctr")
    s.card(3.65, 3.2, 2.45, 0.75, "API :4000", "JWT · RBAC · 校验 · 审计", "teal", None)
    s.card(3.65, 4.2, 1.1, 0.75, "PostgreSQL", "领域真源", "violet", None)
    s.card(4.98, 4.2, 1.1, 0.75, "Redis", "队列与重试", "orange", None)
    s.shape(6.75, 2.48, 3.0, 2.85, fill_color=COLORS["paleViolet"], line_color=COLORS["violet"], radius=True, name="execution services")
    s.text(7.02, 2.72, 2.5, 0.25, "执行服务", 11, COLORS["violet"], True, "ctr")
    s.card(7.0, 3.2, 1.1, 0.75, "CPU Worker", "训练 / 转换", "teal", None)
    s.card(8.3, 3.2, 1.1, 0.75, "GPU Worker", "T4 / TensorRT", "violet", None)
    s.card(7.0, 4.2, 2.4, 0.75, "Export Worker", "异步导出与校验", "orange", None)
    s.shape(10.1, 2.48, 2.3, 2.85, fill_color=COLORS["paleOrange"], line_color=COLORS["orange"], radius=True, name="storage services")
    s.text(10.38, 2.72, 1.75, 0.25, "存储与制品", 11, COLORS["orange"], True, "ctr")
    s.card(10.35, 3.2, 1.8, 0.75, "共享 /data", "artifactRoot / model-cache", "orange", None)
    s.card(10.35, 4.2, 1.8, 0.75, "MinIO", "S3 抽象预留", "blue", None)
    for a, b, c, d, col in [(3.0, 3.55, 3.35, 3.55, "blue"), (6.4, 3.55, 6.75, 3.55, "teal"), (9.75, 3.55, 10.1, 3.55, "orange"), (4.9, 4.2, 7.0, 3.95, "violet")]:
        s.arrow(a, b, c, d, col)
    s.text(0.8, 5.78, 11.6, 0.36, "CPU-only：保留数据、导出、CPU 训练与 FP32 ONNX/TorchScript/OpenVINO；GPU profile：追加 TensorRT、GPU 训练和 SDXL。", 11, COLORS["muted"], False, "ctr")
    s.footer()
    return s


def slide_5() -> Slide:
    s = Slide(5, "业务闭环：一份数据，多条生产路径", "数据集不绑定任务类型，格式与任务在生产时确认")
    s.header("从原始图像到可交付制品")
    nodes = [
        (0.62, "01", "数据集", "图片 · 类别 · 版本", "blue"),
        (2.55, "02", "标注审核", "矩形 · 多边形 · 关键点\nCaption · 统一提交", "cyan"),
        (4.48, "03", "标准格式", "YOLO · COCO · VOC\nMask · Keypoints · Image Folder", "teal"),
        (6.41, "04", "真实训练", "YOLO · SegFormer · HRNet\nSDXL LoRA", "violet"),
        (8.34, "05", "模型仓库", "版本 · 指标 · 血缘\n阶段 · 审计", "orange"),
        (10.27, "06", "转换交付", "ONNX · TensorRT\nTorchScript · OpenVINO", "red"),
    ]
    for x, num, title, body, accent in nodes:
        s.shape(x, 2.38, 1.52, 1.48, fill_color=COLORS["white"], line_color=COLORS[accent], radius=True, line_width=2, name=title)
        s.shape(x + 0.16, 2.56, 0.39, 0.28, text=[(num, 8, COLORS[accent], True, "ctr")], fill_color=COLORS[f"pale{accent.capitalize()}"] if f"pale{accent.capitalize()}" in COLORS else COLORS["paleBlue"], line_color=None, radius=True, name=f"{title} number")
        s.text(x + 0.16, 2.98, 1.2, 0.25, title, 13, COLORS["ink"], True, "ctr")
        s.text(x + 0.13, 3.35, 1.26, 0.35, body, 8, COLORS["muted"], False, "ctr")
        if x < 10.27:
            s.arrow(x + 1.54, 3.12, x + 1.88, 3.12, accent)
    s.shape(1.05, 4.65, 11.25, 0.95, fill_color=COLORS["navy2"], line_color=None, radius=True, name="traceability ribbon")
    s.text(1.36, 4.92, 1.25, 0.22, "全链路可追溯", 11, COLORS["cyan"], True)
    s.text(2.78, 4.87, 9.05, 0.32, "Workspace → Dataset → Annotation Revision → Training Job → Model Version → Conversion Artifact", 13, COLORS["white"], True, "ctr")
    s.card(1.05, 5.9, 3.35, 0.62, "用户体验", "页面只关心状态和制品，不承担执行细节", "blue", None)
    s.card(4.98, 5.9, 3.35, 0.62, "系统治理", "数据库记录状态，Redis 只负责调度", "teal", None)
    s.card(8.91, 5.9, 3.35, 0.62, "工程边界", "Worker 可独立升级，失败不拖垮 API", "violet", None)
    s.footer()
    return s


def slide_6() -> Slide:
    s = Slide(6, "数据架构：领域真源与制品存储分离", "PostgreSQL 管元数据，/data 管文件，审计日志串起变更")
    s.header("数据不是文件夹，而是带版本和生命周期的资产")
    s.shape(0.7, 1.9, 5.35, 4.55, fill_color=COLORS["white"], line_color=COLORS["violet"], radius=True, name="postgres domain")
    s.text(1.0, 2.18, 4.7, 0.28, "PostgreSQL · 领域真源", 14, COLORS["violet"], True)
    tables = [(1.0, 2.78, "datasets / images", "数据集、版本、类别、切分", "blue"), (1.0, 3.58, "annotations", "JSONB 几何、Caption、审核状态、revision", "teal"), (1.0, 4.38, "training / conversion", "任务状态、配置、指标、资源采样", "orange"), (1.0, 5.18, "models / artifacts", "版本、格式、哈希、来源、制品血缘", "violet")]
    for x, y, title, body, accent in tables:
        s.shape(x, y, 4.7, 0.55, fill_color=COLORS["paper"], line_color=COLORS[accent], radius=True, name=title)
        s.text(x + 0.17, y + 0.08, 1.75, 0.18, title, 10, COLORS["ink"], True)
        s.text(x + 1.92, y + 0.08, 2.55, 0.18, body, 8, COLORS["muted"])
    s.shape(6.42, 1.9, 6.2, 4.55, fill_color=COLORS["navy2"], line_color=COLORS["navy2"], radius=True, name="artifact storage")
    s.text(6.76, 2.18, 5.4, 0.28, "共享制品卷 / S3 抽象", 14, COLORS["cyan"], True)
    paths = [(6.86, 2.85, "datasets/<datasetId>/", "原始图片", "blue"), (6.86, 3.58, "exports/<exportId>/", "ZIP 与 manifest", "orange"), (6.86, 4.31, "training/<jobId>/", "best.pt / safetensors", "teal"), (6.86, 5.04, "conversions/<taskId>/", "ONNX / engine / XML+BIN", "violet")]
    for x, y, path, desc, accent in paths:
        s.shape(x, y, 5.25, 0.46, fill_color=COLORS["navy"], line_color=COLORS[accent], radius=True, name=path)
        s.text(x + 0.18, y + 0.08, 2.75, 0.16, path, 9, COLORS["white"], True)
        s.text(x + 3.12, y + 0.08, 1.75, 0.16, desc, 8, "B8D0DE")
    s.text(6.85, 5.83, 5.2, 0.25, "model-cache：部署级预训练缓存，业务删除永不触碰", 9, COLORS["orange"], True)
    s.arrow(6.05, 4.1, 6.38, 4.1, "violet")
    s.text(5.95, 4.32, 0.45, 0.22, "元数据", 8, COLORS["muted"], False, "ctr")
    s.footer()
    return s


def slide_7() -> Slide:
    s = Slide(7, "训练编排：配置校验先于资源消耗", "统一任务状态机 + 真实 Runner 事件 + 可恢复的制品登记")
    s.header("训练任务的生命周期")
    stages = [(0.75, "创建", "TrainingDraft\n版本 / 格式 / 参数", "blue"), (2.65, "校验", "兼容矩阵\n数据集审核 · GPU 能力", "cyan"), (4.55, "入队", "BullMQ\nCPU / GPU queue", "orange"), (6.45, "执行", "Python Runner\n真实反向传播", "violet"), (8.35, "观测", "事件 · Epoch\n指标 · 资源", "teal"), (10.25, "登记", "best artifact\nModelVersion", "red")]
    for x, title, body, accent in stages:
        s.shape(x, 2.3, 1.46, 1.45, fill_color=COLORS["white"], line_color=COLORS[accent], radius=True, line_width=2, name=title)
        s.text(x + 0.12, 2.55, 1.22, 0.24, title, 13, COLORS[accent], True, "ctr")
        s.text(x + 0.13, 3.02, 1.2, 0.42, body, 8, COLORS["muted"], False, "ctr")
        if x < 10.25: s.arrow(x + 1.5, 3.02, x + 1.84, 3.02, accent)
    s.shape(0.75, 4.45, 10.96, 1.28, fill_color=COLORS["navy2"], line_color=None, radius=True, name="state machine")
    s.text(1.02, 4.7, 1.35, 0.22, "状态机", 11, COLORS["cyan"], True)
    s.pill(2.58, 4.66, 1.0, "queued", "orange", True)
    s.arrow(3.62, 4.81, 3.98, 4.81, "orange")
    s.pill(4.08, 4.66, 1.0, "running", "blue", True)
    s.arrow(5.12, 4.81, 5.48, 4.81, "blue")
    s.pill(5.58, 4.66, 1.1, "completed", "teal", True)
    s.arrow(6.72, 4.81, 7.08, 4.81, "teal")
    s.pill(7.18, 4.66, 0.85, "failed", "red", True)
    s.arrow(8.07, 4.81, 8.43, 4.81, "red", 1, True)
    s.pill(8.54, 4.66, 1.05, "retry", "violet", True)
    s.text(9.9, 4.72, 1.42, 0.18, "原失败记录保留", 9, "B8D0DE", False, "ctr")
    s.card(0.75, 6.05, 3.32, 0.48, "数据格式真实生效", "先物化标准格式，再由框架原生加载", "blue", None)
    s.card(4.4, 6.05, 3.32, 0.48, "失败可解释", "事件、日志、错误原因持久化", "orange", None)
    s.card(8.05, 6.05, 3.66, 0.48, "模型可复现", "版本 + 配置 + 数据 + 硬件能力", "violet", None)
    s.footer()
    return s


def slide_8() -> Slide:
    s = Slide(8, "模型转换：以运行时为中心的兼容矩阵", "转换不是改扩展名，而是目标硬件与 Runtime 的真实构建")
    s.header("四种部署格式的边界")
    headers = [(0.8, "格式", 1.5), (2.5, "核心用途", 2.5), (5.25, "CPU 模式", 2.15), (7.65, "GPU 模式", 2.15), (10.05, "交付关注点", 2.35)]
    for x, label, w in headers:
        s.shape(x, 2.05, w, 0.52, text=[(label, 10, COLORS["white"], True, "ctr")], fill_color=COLORS["navy2"], line_color=COLORS["navy2"], radius=True, name=label)
    rows = [
        ("ONNX", "跨框架通用 Runtime", "FP32 ✓", "FP32 / FP16 ✓", "动态轴、算子兼容", "blue"),
        ("TorchScript", "PyTorch 原生部署", "FP32 ✓", "FP32 / FP16 ✓", "PyTorch 版本匹配", "teal"),
        ("OpenVINO", "Intel CPU/GPU/NPU", "FP32 ✓", "FP32 / FP16 ✓", "XML + BIN 成对交付", "orange"),
        ("TensorRT", "NVIDIA 高性能推理", "不可用", "T4 / NVIDIA GPU ✓", "CUDA、TRT、GPU 强绑定", "violet"),
    ]
    for i, (fmt, use, cpu, gpu, note, accent) in enumerate(rows):
        y = 2.68 + i * 0.78
        bg = COLORS["white"] if i % 2 == 0 else "EDF4F8"
        for x, w in [(0.8, 1.5), (2.5, 2.5), (5.25, 2.15), (7.65, 2.15), (10.05, 2.35)]:
            s.shape(x, y, w, 0.62, fill_color=bg, line_color=COLORS["line"], name=f"{fmt} cell")
        s.text(1.0, y + 0.16, 1.1, 0.18, fmt, 11, COLORS[accent], True)
        s.text(2.7, y + 0.16, 2.1, 0.18, use, 9, COLORS["ink"])
        s.text(5.45, y + 0.16, 1.75, 0.18, cpu, 9, COLORS["teal"] if "✓" in cpu else COLORS["red"], True, "ctr")
        s.text(7.85, y + 0.16, 1.75, 0.18, gpu, 9, COLORS["violet"] if "✓" in gpu else COLORS["red"], True, "ctr")
        s.text(10.25, y + 0.16, 1.95, 0.18, note, 9, COLORS["muted"])
    s.shape(0.8, 5.98, 11.6, 0.58, fill_color=COLORS["paleOrange"], line_color=COLORS["orange"], radius=True, name="conversion note")
    s.text(1.08, 6.17, 11.05, 0.18, "转换任务保留 source model、version、precision、target、options 与 artifactId，终态任务可删除并释放受管磁盘空间。", 10, COLORS["ink"], True, "ctr")
    s.footer()
    return s


def slide_9() -> Slide:
    s = Slide(9, "可靠性、安全与运维设计", "将“可用”扩展为可诊断、可恢复、可治理")
    s.header("生产平台必须管理失败和删除")
    s.card(0.75, 2.0, 3.75, 1.2, "统一错误契约", "API 统一返回 code / message / fields / requestId；前端按 code 分支，不解析文案。", "blue", "01")
    s.card(4.78, 2.0, 3.75, 1.2, "鉴权与角色", "JWT 会话、workspace 边界、admin / engineer / annotator 最小权限。", "violet", "02")
    s.card(8.81, 2.0, 3.75, 1.2, "审计与活动", "关键写操作落 audit_logs；工作台聚合最近活动，形成可见的运维线索。", "teal", "03")
    s.card(0.75, 3.65, 3.75, 1.2, "取消与删除协议", "活动任务先取消，等待 Worker 释放锁，再级联清理队列、数据库和目录。", "orange", "04")
    s.card(4.78, 3.65, 3.75, 1.2, "失败可重试", "保留原任务与事件，从持久化配置创建新任务；不覆盖失败现场。", "red", "05")
    s.card(8.81, 3.65, 3.75, 1.2, "备份与恢复", "PostgreSQL、MinIO、Worker 数据卷分别备份；预训练缓存与业务制品隔离。", "cyan", "06")
    s.shape(0.75, 5.5, 11.8, 0.88, fill_color=COLORS["navy2"], line_color=None, radius=True, name="ops rule")
    s.text(1.03, 5.77, 1.7, 0.2, "运维底线", 11, COLORS["cyan"], True)
    s.text(2.92, 5.72, 9.15, 0.3, "业务资源可删除，系统级模型缓存不可误删；每一次删除都返回释放空间，每一次失败都保留证据。", 13, COLORS["white"], True, "ctr")
    s.footer()
    return s


def slide_10() -> Slide:
    s = Slide(10, "落地路线：从平台可用到平台可规模化", "当前实现已形成闭环，后续围绕生产化深度与治理能力演进")
    s.header("建议的三阶段演进")
    phases = [
        (0.75, "阶段一 · 已具备", "可用的生产闭环", ["数据集与标注审核", "真实 CPU/GPU 训练", "模型仓库与转换", "任务删除与磁盘清理"], "teal"),
        (4.45, "阶段二 · 建议优先", "交付与治理增强", ["MinIO/S3 制品归档", "更细粒度权限", "多 Worker 资源调度", "运行时部署验收"], "blue"),
        (8.15, "阶段三 · 规模化", "组织与算力扩展", ["多租户 / SSO", "多节点 GPU 调度", "模型评测与回归集", "在线推理服务编排"], "violet"),
    ]
    for x, title, subtitle, bullets, accent in phases:
        s.shape(x, 2.0, 3.05, 3.45, fill_color=COLORS["white"], line_color=COLORS[accent], radius=True, line_width=2, name=title)
        s.shape(x, 2.0, 3.05, 0.62, fill_color=COLORS[accent], line_color=COLORS[accent], radius=True, name=f"{title} header")
        s.text(x + 0.2, 2.16, 2.65, 0.18, title, 10, COLORS["white"], True)
        s.text(x + 0.2, 2.9, 2.65, 0.32, subtitle, 16, COLORS["ink"], True)
        y = 3.55
        for bullet in bullets:
            s.shape(x + 0.23, y + 0.04, 0.11, 0.11, fill_color=COLORS[accent], line_color=None, radius=True, name="bullet")
            s.text(x + 0.48, y, 2.3, 0.23, bullet, 10, COLORS["muted"])
            y += 0.42
    s.shape(0.75, 5.88, 10.45, 0.62, fill_color=COLORS["paleBlue"], line_color=COLORS["blue"], radius=True, name="closing")
    s.text(1.02, 6.08, 9.9, 0.2, "架构结论：以数据与制品为中心，以队列和 Worker 解耦算力，以审计和生命周期治理保障交付。", 12, COLORS["ink"], True, "ctr")
    s.text(11.42, 5.95, 1.1, 0.48, "谢谢", 20, COLORS["blue"], True, "ctr")
    s.footer()
    return s


def slide_xml(slide: Slide) -> bytes:
    return ET.tostring(slide.root, encoding="utf-8", xml_declaration=True)


def presentation_xml(slides: list[Slide]) -> bytes:
    root = ET.Element("p:presentation")
    declare_namespaces(root, "a", "p", "r")
    master_ids = tag(root, "p:sldMasterIdLst")
    tag(master_ids, "p:sldMasterId", {"id": "2147483648", "r:id": "rId1"})
    sld_ids = tag(root, "p:sldIdLst")
    for idx in range(len(slides)):
        tag(sld_ids, "p:sldId", {"id": str(255 + idx), "r:id": f"rId{idx + 2}"})
    tag(root, "p:sldSz", {"cx": str(int(SW)), "cy": str(int(SH)), "type": "screen16x9"})
    tag(root, "p:notesSz", {"cx": str(int(7.5 * EMU)), "cy": str(int(10 * EMU))})
    tag(root, "p:defaultTextStyle")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def rels_xml(targets: list[tuple[str, str, str]]) -> bytes:
    root = ET.Element("rel:Relationships")
    declare_namespaces(root, "rel")
    for rid, typ, target in targets:
        tag(root, "rel:Relationship", {"Id": rid, "Type": typ, "Target": target})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def content_types(slide_count: int) -> bytes:
    root = ET.Element("ct:Types")
    declare_namespaces(root, "ct")
    tag(root, "ct:Default", {"Extension": "rels", "ContentType": "application/vnd.openxmlformats-package.relationships+xml"})
    tag(root, "ct:Default", {"Extension": "xml", "ContentType": "application/xml"})
    tag(root, "ct:Override", {"PartName": "/ppt/presentation.xml", "ContentType": "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"})
    tag(root, "ct:Override", {"PartName": "/ppt/slideMasters/slideMaster1.xml", "ContentType": "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"})
    tag(root, "ct:Override", {"PartName": "/ppt/slideLayouts/slideLayout1.xml", "ContentType": "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"})
    tag(root, "ct:Override", {"PartName": "/ppt/theme/theme1.xml", "ContentType": "application/vnd.openxmlformats-officedocument.theme+xml"})
    for idx in range(1, slide_count + 1):
        tag(root, "ct:Override", {"PartName": f"/ppt/slides/slide{idx}.xml", "ContentType": "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def master_xml() -> bytes:
    root = ET.Element("p:sldMaster")
    declare_namespaces(root, "a", "p", "r")
    c = tag(root, "p:cSld")
    tree = tag(c, "p:spTree")
    group_nv = tag(tree, "p:nvGrpSpPr")
    tag(group_nv, "p:cNvPr", {"id": "1", "name": ""})
    tag(group_nv, "p:cNvGrpSpPr")
    tag(group_nv, "p:nvPr")
    group_pr = tag(tree, "p:grpSpPr")
    group_xfrm = tag(group_pr, "a:xfrm")
    xfrm(group_xfrm, 0, 0, 0, 0)
    tag(group_xfrm, "a:chOff", {"x": "0", "y": "0"})
    tag(group_xfrm, "a:chExt", {"cx": "0", "cy": "0"})
    tag(root, "p:clrMap", {"bg1": "lt1", "tx1": "dk1", "bg2": "lt2", "tx2": "dk2", "accent1": "accent1", "accent2": "accent2", "accent3": "accent3", "accent4": "accent4", "accent5": "accent5", "accent6": "accent6", "hlink": "hlink", "folHlink": "folHlink"})
    layouts = tag(root, "p:sldLayoutIdLst")
    tag(layouts, "p:sldLayoutId", {"id": "2147483649", "r:id": "rId1"})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def layout_xml() -> bytes:
    root = ET.Element("p:sldLayout", {"type": "blank", "preserve": "1"})
    declare_namespaces(root, "a", "p", "r")
    c = tag(root, "p:cSld")
    tree = tag(c, "p:spTree")
    group_nv = tag(tree, "p:nvGrpSpPr")
    tag(group_nv, "p:cNvPr", {"id": "1", "name": ""})
    tag(group_nv, "p:cNvGrpSpPr")
    tag(group_nv, "p:nvPr")
    group_pr = tag(tree, "p:grpSpPr")
    group_xfrm = tag(group_pr, "a:xfrm")
    xfrm(group_xfrm, 0, 0, 0, 0)
    tag(group_xfrm, "a:chOff", {"x": "0", "y": "0"})
    tag(group_xfrm, "a:chExt", {"cx": "0", "cy": "0"})
    tag(root, "p:clrMapOvr")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def theme_xml() -> bytes:
    root = ET.Element("a:theme", {"name": "Forge AI"})
    declare_namespaces(root, "a")
    elements = tag(root, "a:themeElements")
    clr = tag(elements, "a:clrScheme", {"name": "Forge"})
    for name, val in [("a:dk1", "000000"), ("a:lt1", "FFFFFF"), ("a:dk2", "13283A"), ("a:lt2", "F4F8FB"), ("a:accent1", COLORS["blue"]), ("a:accent2", COLORS["cyan"]), ("a:accent3", COLORS["teal"]), ("a:accent4", COLORS["violet"]), ("a:accent5", COLORS["orange"]), ("a:accent6", COLORS["red"]), ("a:hlink", "1685E8"), ("a:folHlink", "8066E8")]:
        node = tag(clr, name)
        color(node, val)
    fonts = tag(elements, "a:fontScheme", {"name": "Forge Fonts"})
    major = tag(fonts, "a:majorFont")
    tag(major, "a:latin", {"typeface": "Aptos Display"})
    tag(major, "a:ea", {"typeface": "Noto Sans CJK SC"})
    minor = tag(fonts, "a:minorFont")
    tag(minor, "a:latin", {"typeface": "Aptos"})
    tag(minor, "a:ea", {"typeface": "Noto Sans CJK SC"})
    tag(elements, "a:fmtScheme", {"name": "Forge Format"})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def build() -> Path:
    slides = [slide_1(), slide_2(), slide_3(), slide_4(), slide_5(), slide_6(), slide_7(), slide_8(), slide_9(), slide_10()]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types(len(slides)))
        archive.writestr("_rels/.rels", rels_xml([("rId1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", "ppt/presentation.xml")]))
        archive.writestr("ppt/presentation.xml", presentation_xml(slides))
        pres_rels = [("rId1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster", "slideMasters/slideMaster1.xml")]
        pres_rels.extend((f"rId{i + 2}", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide", f"slides/slide{i + 1}.xml") for i in range(len(slides)))
        archive.writestr("ppt/_rels/presentation.xml.rels", rels_xml(pres_rels))
        archive.writestr("ppt/slideMasters/slideMaster1.xml", master_xml())
        archive.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels_xml([("rId1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout", "../slideLayouts/slideLayout1.xml"), ("rId2", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme", "../theme/theme1.xml")]))
        archive.writestr("ppt/slideLayouts/slideLayout1.xml", layout_xml())
        archive.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", rels_xml([("rId1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster", "../slideMasters/slideMaster1.xml")]))
        archive.writestr("ppt/theme/theme1.xml", theme_xml())
        for idx, slide in enumerate(slides, 1):
            archive.writestr(f"ppt/slides/slide{idx}.xml", slide_xml(slide))
            archive.writestr(f"ppt/slides/_rels/slide{idx}.xml.rels", rels_xml([("rId1", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout", "../slideLayouts/slideLayout1.xml")]))
    return OUT


if __name__ == "__main__":
    path = build()
    print(path)
