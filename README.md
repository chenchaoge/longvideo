<div align="center">

# LongVideo · 专做口播、教程类的长视频SKILL

不套任何模版，不做同质化视频
每一次AI制作视频，都根据你的文稿主题，重新思考
画面、剧本、分镜、配乐、音效、动效，所有

```sh
git clone https://github.com/chenchaoge/longvideo.git ~/.claude/skills/longvideo
```
</div>

## 长视频

### 【待补：主打案例的片名】

【待补：主打案例的 GIF，截自成片】

【待补：一句话介绍这条片子】

<table><tr>
<td width="50%"><img src="assets/showcase/0926-opening.gif" alt="0926成品开头12秒" width="100%" /><br/>【待补：一句说明】</td>
</tr></table>


画面、配乐、音效用什么技术，由 AI 按视频主题深度思考后定：画面可以用 Canvas 2D、three.js、SVG，也可以用 Manim、Blender 这类工具做好再接进来；配乐、音效可以用 Python 合成，也可以交任何工具做好的音频文件。混音时配乐自动给人声让位，响度统一到 -14 LUFS。

出片后有一道质检：核对成片时长和工程差多少，在每张素材图出现前后抽帧，再全片均匀抽 9 帧，拼成 3×3 总览图检查。

---


```
longvideo/
├── SKILL.md             # 主流程和规矩
├── references/          # 各步骤细则
└── scripts/
    ├── render.mjs       # 渲染、出片、质检（菜单启动）
    ├── srt.mjs          # 文稿转字幕
    ├── index.html, js/  # 画面引擎
    ├── audio/           # 混音和合成零件
    ├── jianying/        # 剪映草稿
    └── fonts/           # 烧字幕和质检标注用的思源黑体粗体
```

建议用Opus5.5、Fable5或者Astra模型。暂时只支持 Windows。

依赖：Node.js（测过 22）、Python 3（测过 3.13）、带 libass 的 ffmpeg 和 ffprobe（放进 PATH）、装在默认位置的 Microsoft Edge、剪映专业版（要配音或导回剪映才用）、字体 Noto Sans SC 和 Noto Serif SC（要 Google 版，Adobe 版叫 Source Han，画面认不到）。安装：

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
| 【待补：其他平台】 | 【待补：链接】 |

## 许可证

代码和文档：MIT，见 [LICENSE](LICENSE)。

例外：`scripts/fonts/NotoSansSC-Bold.ttf` 是思源黑体粗体，沿用 SIL OFL 1.1 许可，见 [scripts/fonts/OFL.txt](scripts/fonts/OFL.txt)。

---

<div align="center">

MIT License © [chenchaoge](https://github.com/chenchaoge)

</div>

---
