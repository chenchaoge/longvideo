<div align="center">

# LongVideo · 专做口播、教程类的长视频SKILL

### 我制作的成品长视频示例

<table><tr>
<td width="50%"><img src="assets/showcase/0926-opening.gif" alt="SKILL：LongVideo制作的成品长视频示例" width="100%" /><br/>一个外行人用AI做小游戏</td>
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

## LongVideo skill 说明

画面、配乐、音效用什么技术，由 AI 按视频主题深度思考后定：画面可以用 Canvas 2D、three.js、SVG，也可以用 Manim、Blender 这类工具做好再接进来；配乐、音效可以用 Python 合成，也可以交任何工具做好的音频文件。混音时配乐自动给人声让位，响度统一到 -14 LUFS。

配音可以用剪映文本朗读、在剪映里自己录，或用你现成的配音。剪映文本朗读的配音，AI 直接在剪映草稿里对齐字幕：草稿先备份，配音还是一段一段的，不剪不改；成片做好后也由 AI 直接放回剪映草稿。没装剪映也能开工，用现成配音全程不用剪映。

出片后有一道质检：核对成片时长和工程差多少，在每张素材图出现前后抽帧，再全片均匀抽 9 帧，拼成 3×3 总览图检查。

成片定稿后做封面：你只给封面文案，AI 用成片的画风和角色设计封面，按平台出对应比例。横版出 4:3 和 3:4（视频号、抖音用），发 YouTube 再加 16:9；竖版出 3:4。

---

```
longvideo/
├── SKILL.md             # 主流程和规矩
├── references/          # 各步骤细则
└── scripts/
    ├── render.mjs       # 渲染、出片、质检、封面（菜单启动）
    ├── srt.mjs          # 文稿转字幕
    ├── portrait_subs.mjs  # 竖版烧字幕（自己折行、按行定位）
    ├── index.html, js/  # 画面引擎
    ├── audio/           # 混音和合成零件
    ├── jianying/        # 剪映草稿
    ├── clean.mjs        # 项目完成后清理中间文件和临时文件（菜单启动）
    ├── avatar.py        # 作者头像按脸的比例裁切（菜单启动）
    └── fonts/           # 烧字幕和质检标注用的思源黑体粗体
```

建议用Opus5.5、Fable5或者Astra模型。暂时只支持 Windows。

依赖：Node.js（测过 22）、Python 3（测过 3.13）、带 libass 的 ffmpeg 和 ffprobe（放进 PATH）、装在默认位置的 Microsoft Edge、剪映专业版（只有用剪映配音时才用，没装也能开工；AI 读写剪映草稿测过 11.5 版，读写时要退出剪映）、字体 Noto Sans SC 和 Noto Serif SC（要 Google 版，Adobe 版叫 Source Han，画面认不到）。安装（以 Claude Code 为例；用别的 AI 工具，把 `~/.claude/skills` 换成它读取 skill 的目录）：

```sh
git clone https://github.com/chenchaoge/longvideo.git ~/.claude/skills/longvideo
cd ~/.claude/skills/longvideo/scripts
npm install
pip install -r requirements.txt
```


---

## 关于作者

| | |
|:---|:---|
| 作者 | 陈朝歌chen |
| GitHub | [chenchaoge](https://github.com/chenchaoge) |
| 抖音 | [陈朝歌chen](https://www.douyin.com/user/MS4wLjABAAAAkZOGJtVUaec6vsz1qgF_xnYhgNRvZVoON--_Zl7sGw94dOK2neTeOauA3RYIbD72?from_tab_name=main&vid=7689842892655209125) |
| 推特 X | [陈朝歌chen](https://x.com/chenchaoge1900) |

## 许可证

代码和文档：MIT，见 [LICENSE](LICENSE)。

例外：`scripts/fonts/NotoSansSC-Bold.ttf` 是思源黑体粗体，沿用 SIL OFL 1.1 许可，见 [scripts/fonts/OFL.txt](scripts/fonts/OFL.txt)。

---

<div align="center">

MIT License © [chenchaoge](https://github.com/chenchaoge)

</div>

---
