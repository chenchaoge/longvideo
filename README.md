<div align="center">

# LongVideo · 专做口播、教程类的长视频SKILL

### 我制作的成品长视频示例

<table><tr>
<td width="50%"><img src="assets/showcase/0926-opening-v2.gif" alt="SKILL：LongVideo制作的成品长视频示例" width="100%" /><br/>一个外行人用AI做小游戏</td>
</tr></table>

### 播放27万；8000多点赞；8300多收藏

### 长视频的完整版 [《一个外行人用AI做小游戏》](https://www.douyin.com/video/7689842892655209125)

<br>
LongVideo · 专做口播、教程类的长视频SKILL<br>
<br>
不套任何模版，不做同质化视频<br>
每一次AI制作视频，都根据你的文稿主题，重新思考<br>
画面、剧本、分镜、配乐、音效、动效 —— 所有<br>
<br>

```sh
git clone https://github.com/chenchaoge/longvideo.git ~/.claude/skills/longvideo
```
以 Claude Code 为例；用别的 AI 工具，换成它读取 skill 的目录
</div>

<br>

**最近主要更新：**
1. 支持 Windows 和 Mac 两种系统
2. 流程新增「视频文案总结」：出片后自动写短视频标题、平台介绍和 200 字视频介绍
3. 新增个人用户习惯档案：记录你的做视频习惯（账号、头像、视频和封面风格），每条视频自动照着做
4. 提高视频动效的质感要求：所有视频有画面质量的最低标准
5. 新增画面排版和素材检查清单
6. 新增发布合规检查，避免视频上传平台时违规：画面里不出现第三方品牌名和 LOGO、他人账号、完整网址、联系方式；素材自带的水印和字幕先处理再用

## LongVideo skill 说明

画面、配乐、音效用什么技术，由 AI 按视频主题深度思考后定：画面可以用 Canvas 2D、three.js、SVG，也可以用 Manim、Blender 这类工具做好再接进来；配乐、音效可以用 Python 合成，也可以交任何工具做好的音频文件。混音时配乐自动给人声让位，响度统一到 -14 LUFS。

配音可以用剪映文本朗读、在剪映里自己录，或用你现成的配音。Windows 上，AI 直接读写剪映草稿：在草稿里把字幕对上配音（草稿先备份，配音还是一段一段的，不剪不改）。Mac 上，你在剪映里做好配音、导出音频和字幕，AI 把字幕对上配音后放进 OpenChatCut 项目给你看。成片做好后默认不放回剪映草稿或 OpenChatCut 项目，你要放就说一声。没装剪映也能开工，用现成配音全程不用剪映。

出片后有一道质检：核对成片时长和工程差多少，在每张素材图出现前后抽帧，再全片均匀抽 9 帧，拼成 3×3 总览图检查。

成片定稿后做封面：封面文字分三层——一句吸引人点进来的话（字最大）、这条视频的浓缩重点（也是大字）、几行补充小字；你给几层都行，没给的 AI 按视频内容写，交图时说清每层为什么这么写。默认是黑底暗纹、只放字的风格，按平台出对应比例：横版出 4:3 和 3:4（视频号、抖音用），发 YouTube 再加 16:9；竖版出 3:4。每改一次另出一版，图名带版本号，旧版的封面都留着。

封面之后写视频文案：短视频标题、发在短视频平台的介绍、视频本身的 200 字介绍，存成工作目录里的 `<工作目录名>的视频总结.txt`，交给你时说清每样是怎么想的。

个人用户习惯档案（可选）：你自己整理的做视频习惯，比如账号昵称、头像在视频里怎么出现、求关注收藏的动画、喜欢的视频和封面风格，还可以带现成的脚本、图片和音效。在 skill 目录建一个 `个人用户习惯档案位置.txt`，第一行写档案文件夹的路径，文件夹里放 `个人用户习惯档案.md`；AI 每条视频开场会悄悄查，有就照着做，没有就照常开工。档案和位置文件都只在你的电脑上，不会上传；怎么用见 `references/个人用户习惯档案.md`。

---

```
longvideo/
├── SKILL.md             # 主流程和规矩
├── references/          # 各步骤细则
├── 个人用户习惯档案位置.txt  # 可选：你的习惯档案在哪（只在本机，不上传）
└── scripts/
    ├── render.mjs       # 渲染、出片、质检、封面（菜单启动）
    ├── srt.mjs          # 文稿转字幕
    ├── portrait_subs.mjs  # 竖版烧字幕（自己折行、按行定位）
    ├── index.html, js/  # 画面引擎
    ├── audio/           # 混音和合成零件
    ├── jianying/        # 剪映：读写草稿（只 Windows）、剪映导出的配音对齐（Windows、Mac）
    ├── clean.mjs        # 项目完成后清理中间文件和临时文件（菜单启动）
    ├── avatar.py        # 作者头像按脸的比例裁切（菜单启动）
    ├── start_check.py   # 开工检查：缺什么软件、照哪一节装
    ├── browsers.json    # 渲染用的浏览器在 Windows、Mac 上找哪些位置
    └── fonts/           # 烧字幕和质检标注用的思源黑体粗体
```

建议用Opus5.5、Fable5或者Astra模型。Windows 和 Mac 都能用，编辑软件各用一套：Windows 用剪映草稿，Mac 用 OpenChatCut 项目。Mac 项目的创建、再次修改和导出已做基础测试，完整视频制作仍需装齐下述依赖。

依赖：Node.js 18 或更新（测过 22）、Python 3.11 或更新（测过 3.13）、带 libass 的 ffmpeg 和 ffprobe（放进 PATH）、浏览器（Windows 用自带的 Edge，Mac 用 Edge 或 Chrome）、剪映（只有用剪映配音时才用，没装也能开工；Windows 用电脑版剪映，AI 读写草稿测过 11.5 版，读写时要退出剪映；Mac 用 Mac 版剪映，只用来做配音、导出音频和字幕）、OpenChatCut（只有 Mac 要装，第 1 步就装好、连上）、字体 Noto Sans SC 和 Noto Serif SC（要 Google 版，Adobe 版叫 Source Han，画面认不到）。各系统的装法见 `references/装软件.md`。安装（以 Claude Code 为例；用别的 AI 工具，把 `~/.claude/skills` 换成它读取 skill 的目录；Mac 上把 `python` 换成 `python3`）：

```sh
git clone https://github.com/chenchaoge/longvideo.git ~/.claude/skills/longvideo
cd ~/.claude/skills/longvideo/scripts
npm install
python -m pip install -r requirements.txt
python start_check.py
```


---

## 关于作者

| | |
|:---|:---|
| 作者 | 陈朝歌chen |
| GitHub | [chenchaoge](https://github.com/chenchaoge) |
| 抖音 | [陈朝歌chen](https://www.douyin.com/user/MS4wLjABAAAAkZOGJtVUaec6vsz1qgF_xnYhgNRvZVoON--_Zl7sGw94dOK2neTeOauA3RYIbD72?from_tab_name=main&vid=7689842892655209125) |

## 许可证

本项目版权归陈朝歌chen 所有，保留所有权利，完整条款见 [LICENSE](LICENSE)

- 用户可以免费安装和使用这个 Skill，包括给自己的账号做视频、用做出的视频赚钱、给自己的客户代做视频，也可以在自己的设备上修改后自用
- 未经书面许可，不得打包进其他产品、出售或公开发布修改版，不得部署成供他人调用的服务（包括但不限于 agent、小程序、API 等），也不得用于训练 AI 模型。分享本仓库链接不受限制
- 例外：`scripts/fonts/NotoSansSC-Bold.ttf` 是思源黑体粗体，沿用 SIL OFL 1.1 许可，见 [scripts/fonts/OFL.txt](scripts/fonts/OFL.txt)

---

<div align="center">

版权所有 © 2026 [陈朝歌chen](https://github.com/chenchaoge)，保留所有权利

</div>

---
