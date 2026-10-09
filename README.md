# longvideo

把一篇文稿或一个视频想法做成动画视频的 Claude Code skill。画面、配乐、音效都由 Claude 为每条视频从头写代码生成，不套模板；配音可要可不要，口播类成片能导回剪映接着剪。

## 能做什么

- 输入：文稿（TXT，UTF-8）或视频想法，可以附图片、录像素材
- 输出：横版 1280×720 或竖版 1080×1920 的 MP4；有字幕的另出一版带字幕的
- 配音：在剪映里录，或用现成的配音；混音时配乐自动给人声让位，响度统一到 -14 LUFS

## 流程（共 7 步）

1. 准备工作：核对文件和想法，判断视频类型
2. 文稿转字幕（要配音才做）
3. 取得配音（在剪映里）
4. 对齐配音和字幕（在剪映里）
5. 做动画：画面用 Canvas 2D 写，配乐和音效用 Python 合成
6. 出片：无头 Edge 分段并行渲染，ffmpeg 合成，自动质检
7. 导入剪映（只有口播类做）

不要配音、或者没有文稿的视频，只走第 1、5、6 步。

## 运行环境

只支持 Windows。

- Node.js（测过 22）
- Python 3（测过 3.13）
- ffmpeg 和 ffprobe，要带 libass，放进 PATH
- Microsoft Edge，装在默认位置
- 剪映专业版：要配音或要导回剪映时才用
- 字体：Google 的 Noto Sans SC、Noto Serif SC。Adobe 版叫 Source Han，画面认不到

## 安装

把仓库放进 Claude Code 的 skills 目录，再装依赖：

```
git clone https://github.com/chenchaoge/longvideo.git ~/.claude/skills/longvideo
cd ~/.claude/skills/longvideo/scripts
npm install
pip install -r requirements.txt
```

## 用法

在 Claude Code 里说一句，比如：

```
用 D:\视频\0920 里的文稿做一条动画视频
```

一条视频用一个文件夹。Claude 会先核对准备情况，之后每一步要你做什么，会一件一件告诉你。改稿时会另做一稿，旧稿原样保留。

## 目录

- `SKILL.md`：主流程和规矩
- `references/`：各步骤细则
- `scripts/`：渲染（render.mjs）、配乐和混音（audio/）、剪映草稿（jianying/）

## 许可

代码和文档用 MIT 许可，见 [LICENSE](LICENSE)。`scripts/fonts/NotoSansSC-Bold.ttf` 是思源黑体粗体，用 SIL OFL 1.1 许可，见 [scripts/fonts/OFL.txt](scripts/fonts/OFL.txt)。
