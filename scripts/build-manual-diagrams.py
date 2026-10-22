"""Draw version-neutral process diagrams for the user manual with Pillow.

The PNGs are shared by Markdown, the offline HTML, DOCX, and PDF. They explain
the flow without presenting an invented application screenshot.
"""
from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/images/user-manual"
FONT_DIR = Path("C:/Windows/Fonts")
FONT = FONT_DIR / "msyh.ttc"
BOLD = FONT_DIR / "msyhbd.ttc"

NAVY = "#17324D"
BLUE = "#245F82"
TEAL = "#087F79"
INK = "#243746"
MUTED = "#607383"
PALE = "#F4F8FA"
LINE = "#D5E1E7"
WHITE = "#FFFFFF"


def font(size: int, bold: bool = False):
    path = BOLD if bold else FONT
    if not path.exists():
        raise FileNotFoundError(f"Microsoft YaHei is required to draw Chinese diagrams: {path}")
    return ImageFont.truetype(str(path), size)


def center(draw: ImageDraw.ImageDraw, xy: tuple[int, int], value: str, face, fill=INK):
    box = draw.textbbox((0, 0), value, font=face)
    width = box[2] - box[0]
    height = box[3] - box[1]
    draw.text((xy[0] - width / 2, xy[1] - height / 2 - box[1]), value, font=face, fill=fill)


def base(title: str, subtitle: str, height: int):
    canvas = Image.new("RGB", (1700, height), WHITE)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((2, 2, 1697, height - 3), 22, fill=PALE, outline=LINE, width=3)
    draw.text((52, 28), title, font=font(39, True), fill=NAVY)
    draw.text((54, 85), subtitle, font=font(25), fill=MUTED)
    return canvas, draw


def arrow(draw: ImageDraw.ImageDraw, x0: int, x1: int, y: int):
    draw.line((x0, y, x1 - 11, y), fill=TEAL, width=5)
    draw.polygon([(x1 - 15, y - 12), (x1, y), (x1 - 15, y + 12)], fill=TEAL)


def card(draw: ImageDraw.ImageDraw, x: int, y: int, width: int, height: int,
         number: str, title: str, detail: list[str], accent: str):
    draw.rounded_rectangle((x, y, x + width, y + height), 17, fill=WHITE, outline=LINE, width=3)
    draw.rounded_rectangle((x + 21, y + 22, x + 75, y + 76), 14, fill=accent)
    center(draw, (x + 48, y + 49), number, font(29, True), WHITE)
    draw.text((x + 91, y + 25), title, font=font(31, True), fill=NAVY)
    for index, line in enumerate(detail):
        draw.text((x + 26, y + 105 + index * 38), line, font=font(23), fill=MUTED)


def reference_flow(*, handbook_roles: bool = False):
    canvas, draw = base("成果进入会话", "本次使用哪些成果，由成员选择并确认。", 413)
    xs = [44, 462, 880, 1298]
    titles = ["选择来源", "加入会话", "待带入", "已带入"]
    details = [
        ["个人项目成果", "或可用的团队成果"],
        ["引用项目成果", "并指定目标会话"],
        ["保存当前版本副本", "发送失败仍保留"],
        ["消息发送成功后", "成为 AI 参考内容"],
    ]
    for i, x in enumerate(xs):
        card(draw, x, 143, 358, 188, str(i + 1), titles[i], details[i], TEAL if i == 3 else BLUE)
        if i < 3:
            arrow(draw, x + 365, xs[i + 1] - 8, 238)
    draw.text((53, 352), "已发送的引用保留当时版本；待发送的团队引用会核对删除状态。", font=font(23), fill=TEAL)
    output = ROOT / "docs/handbook/diagrams" if handbook_roles else OUT
    output.mkdir(parents=True, exist_ok=True)
    canvas.save(output / "reference-flow.png", optimize=True)


def publish_flow(*, handbook_roles: bool = False):
    canvas, draw = base("成果整理与上传", "AI 先归纳，成员核对后才发布到团队。", 410)
    xs = [36, 374, 712, 1050, 1388]
    titles = ["冻结来源", "AI 整理", "人工审核", "上传附件", "发布成果"]
    details = [
        ["复制当时的会话", "与所选资料"],
        ["每类最多 1 条", "三类最多 3 条"],
        ["核对类别与正文", "核对已勾选附件"],
        ["仅上传所选文件", "失败可原记录重试"],
        ["如有附件先上传", "核对传输记录"],
    ]
    for i, x in enumerate(xs):
        card(draw, x, 143, 277, 190, str(i + 1), titles[i], details[i], TEAL if i == 4 else BLUE)
        if i < 4:
            arrow(draw, x + 286, xs[i + 1] - 9, 238)
    draw.text((52, 352), "无新成果时先确认本次无需保留；有成果时以传输记录和团队成果库为准。", font=font(23), fill=TEAL)
    output = ROOT / "docs/handbook/diagrams" if handbook_roles else OUT
    output.mkdir(parents=True, exist_ok=True)
    canvas.save(output / "publish-flow.png", optimize=True)


def sync_scope(*, handbook_roles: bool = False):
    canvas, draw = base("个人成果的同步范围", "连接同一成员账号后，可在另一台电脑恢复已同步的个人内容。", 478)
    blocks = [
        (46, "随账号私有同步", ["个人成果 · 别名", "整理草稿 · 附件 · 动态处理记录"], TEAL),
        (868, "仅保留在本机", ["Session · 完整对话 · 输入草稿", "代码目录 · CLI 登录凭据"], BLUE),
    ]
    for x, title, lines, accent in blocks:
        draw.rounded_rectangle((x, 145, x + 786, 322), 20, fill=WHITE, outline=LINE, width=3)
        draw.rounded_rectangle((x + 25, 169, x + 35, 295), 5, fill=accent)
        draw.text((x + 59, 164), title, font=font(32, True), fill=NAVY)
        for index, line in enumerate(lines):
            draw.text((x + 59, 225 + index * 48), line, font=font(25), fill=INK)
    draw.rounded_rectangle((46, 349, 1654, 432), 14, fill="#E4F2F0")
    draw.text((74, 370), "两台电脑修改同一资料：比较本机版本与账号版本 → 逐项选择 → 再同步", font=font(26, True), fill=TEAL)
    output = ROOT / "docs/handbook/diagrams" if handbook_roles else OUT
    output.mkdir(parents=True, exist_ok=True)
    canvas.save(output / "sync-scope.png", optimize=True)


def task_lifecycle(*, handbook_roles: bool = False):
    group_admin = "项目组管理员" if handbook_roles else "组管理员"
    canvas, draw = base("任务从派发到验收", f"负责人提交结果和证据，{group_admin}决定通过或退回。", 570)
    xs = [45, 470, 895, 1320]
    titles = ["待开始", "进行中", "待验收", "已完成"]
    details = [
        [f"{group_admin}派发", "负责人阅读任务与附件"],
        ["负责人创建或继续会话", "完成工作并准备证据"],
        ["负责人提交说明与证据", f"{group_admin}审核或退回"],
        ["验收通过后结束", "记录与附件继续保留"],
    ]
    for i, x in enumerate(xs):
        card(draw, x, 145, 360, 215, str(i + 1), titles[i], details[i], TEAL if i == 3 else BLUE)
        if i < 3:
            arrow(draw, x + 368, xs[i + 1] - 8, 252)
    draw.line((1075, 363, 1075, 421, 650, 421, 650, 378), fill=TEAL, width=5)
    draw.polygon([(638, 393), (650, 375), (662, 393)], fill=TEAL)
    center(draw, (862, 455), "退回后继续原会话，补充后再次提交", font(23, True), TEAL)
    footer = ("项目组管理员自派可直接确认完成；取消不计完成。任务可移入已删除，恢复或彻底删除。"
              if handbook_roles else "组管理员自派可直接确认完成；取消不计完成。结束任务可移入已删除，恢复或彻底删除。")
    draw.text((55, 509), footer,
              font=font(23), fill=INK)
    output = ROOT / "docs/handbook/diagrams" if handbook_roles else OUT
    output.mkdir(parents=True, exist_ok=True)
    canvas.save(output / "task-lifecycle.png", optimize=True)


def deployment_logic(*, handbook_roles: bool = False):
    member_a = "项目组成员 A" if handbook_roles else "成员 A"
    member_b = "项目组成员 B" if handbook_roles else "成员 B"
    subtitle = ("总管理员、项目组管理员、项目组成员 A 和 B 独立接入；同类节点可以继续增加。"
                if handbook_roles else "总管理员、项目组管理员、成员 A 和 B 独立接入；同类节点可以继续增加。")
    canvas, draw = base("正式部署：独立节点与两类服务", subtitle, 1010)
    MODEL = "#77559B"
    ACCESS = "#8295A3"

    clients = [
        (44, "总管理员", "管理员版", ["建组建号，任命项目组管理员" if handbook_roles else "建组建号，任命组管理员", "初始化团队空间与服务端", "可选转发成员的模型连接"], BLUE),
        (456, "项目组管理员", "用户版", ["创建项目，派发任务", "维护说明和团队成果" if handbook_roles else "维护说明和公共成果", "每组可有多位项目组管理员" if handbook_roles else "每组可有多位组管理员"], TEAL),
        (868, member_a, "用户版", ["开展 AI 会话与代码工作", "管理账号私有资料", "确认发布成果与附件"], TEAL),
        (1280, member_b, "用户版", ["接收任务并开展会话", "复用本地和团队成果", "确认发布成果与附件"], TEAL),
    ]
    for x, title, app, lines, accent in clients:
        draw.rounded_rectangle((x, 155, x + 376, 455), 18, fill=WHITE, outline=LINE, width=3)
        draw.rounded_rectangle((x + 20, 177, x + 32, 432), 6, fill=accent)
        draw.text((x + 53, 173), title, font=font(30, True), fill=NAVY)
        draw.rounded_rectangle((x + 53, 228, x + 182, 270), 11,
                               fill="#EAF2F5" if app == "管理员版" else "#E8F3F2")
        center(draw, (x + 117, 249), app, font(23, True), accent)
        for i, line in enumerate(lines):
            draw.text((x + 53, 294 + i * 43), line, font=font(23), fill=INK)

    # The administrator uses a separate privileged management connection.
    draw.line((232, 457, 232, 641), fill=BLUE, width=5)
    draw.polygon([(219, 628), (232, 649), (245, 628)], fill=BLUE)
    center(draw, (327, 556), "管理 SSH", font(23, True), BLUE)

    # Each group administrator and member owns an independent user-app connection.
    for x in (644, 1056, 1468):
        draw.line((x, 457, x, 520), fill=ACCESS, width=5)
        draw.ellipse((x - 7, 513, x + 7, 527), fill=ACCESS)
    draw.line((644, 520, 1468, 520), fill=ACCESS, width=5)
    center(draw, (1056, 557), "各自登录，连接方式相同", font(22), MUTED)
    draw.line((810, 520, 810, 640), fill=TEAL, width=5)
    draw.polygon([(797, 628), (810, 649), (823, 628)], fill=TEAL)
    center(draw, (701, 606), "用户版 SSH/SFTP" if handbook_roles else "成员 SSH/SFTP", font(22, True), TEAL)
    draw.line((1440, 520, 1440, 640), fill=MODEL, width=5)
    draw.polygon([(1427, 628), (1440, 649), (1453, 628)], fill=MODEL)
    center(draw, (1512, 606), "模型 HTTPS", font(22, True), MODEL)

    # The server box contains its functional parts; every label belongs to a node.
    draw.rounded_rectangle((45, 650, 1065, 895), 20, fill=WHITE, outline=LINE, width=3)
    draw.text((78, 671), "Linux 团队服务器", font=font(34, True), fill=NAVY)
    server_parts = [
        (72, "身份与权限", ["使用成员账号连接中央节点", "控制可见项目和文件"]),
        (399, "安全写入服务", ["检查谁在操作", "核对目标、版本与权限"]),
        (726, "内容空间", ["团队项目共享资料", "本人账号私有资料"]),
    ]
    for x, title, lines in server_parts:
        draw.rounded_rectangle((x, 744, x + 309, 866), 13, fill=PALE, outline=LINE, width=2)
        draw.text((x + 16, 758), title, font=font(25, True), fill=NAVY)
        for i, line in enumerate(lines):
            draw.text((x + 16, 801 + i * 31), line, font=font(19), fill=INK)

    draw.rounded_rectangle((1135, 650, 1656, 895), 20, fill=WHITE, outline=LINE, width=3)
    draw.text((1168, 671), "Codex / Cursor 模型服务", font=font(31, True), fill=NAVY)
    draw.text((1168, 743), "每人使用自己的模型账号和额度", font=font(22), fill=INK)
    draw.text((1168, 785), "能直连就直连，否则经管理端转发", font=font(22), fill=INK)
    draw.text((1168, 827), "管理端只转发连接，不接管账号", font=font(22), fill=MODEL)

    boundary = ("数据边界：代码、Session、完整对话及模型凭据留在各自本机；成果经用户确认后才进入授权项目。"
                if handbook_roles else "数据边界：代码、Session、完整对话及模型凭据留在各自本机；成果经成员确认后才进入授权项目。")
    draw.text((54, 932), boundary,
              font=font(24), fill=INK)
    output = ROOT / "docs/handbook/diagrams" if handbook_roles else OUT
    output.mkdir(parents=True, exist_ok=True)
    canvas.save(output / "deployment-logic.png", optimize=True)

if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--handbook-roles"]:
        reference_flow(handbook_roles=True)
        publish_flow(handbook_roles=True)
        sync_scope(handbook_roles=True)
        task_lifecycle(handbook_roles=True)
        deployment_logic(handbook_roles=True)
        sys.exit(0)
    OUT.mkdir(parents=True, exist_ok=True)
    reference_flow()
    publish_flow()
    sync_scope()
    task_lifecycle()
    deployment_logic()
    for name in ("reference-flow.png", "publish-flow.png", "sync-scope.png", "task-lifecycle.png", "deployment-logic.png"):
        print(OUT / name)
