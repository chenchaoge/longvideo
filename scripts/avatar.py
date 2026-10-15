# -*- coding: utf-8 -*-
"""作者头像裁切（菜单启动，在用户工作目录里运行）：按脸的比例算出照片上要裁的正方形，画成圆形头像时用
标准：脸宽占正方形边长的 FACE_W，脸的中心横向在正中、竖向离上边 FACE_Y；原图放不下就取放得下的最大正方形，脸尽量靠近这个位置
脸框用 OpenCV 自带的正脸检测量（参数在下面常量区），标准里的比例就是按它量的，不要换量法"""
import os
import sys
import traceback

import cv2
import numpy as np

sys.dont_write_bytecode = True
WORK = os.getcwd()                                            # 用户工作目录（运行时所在目录），图片路径相对它
ENG = os.path.join(WORK, '工程文件')                            # 与 render.mjs 的 ENG_DIR 一致
FACE_W = 0.42                                                 # 脸宽 / 正方形边长
FACE_Y = 0.38                                                 # 脸中心离正方形上边的距离 / 边长（横向固定在正中 0.5）
CASCADE = 'haarcascade_frontalface_default.xml'                # OpenCV 自带的正脸检测模型
SCALE_STEP, MIN_NEIGHBORS, MIN_FACE = 1.05, 6, 0.1             # 检测参数：缩放步长、至少几次命中才算脸、脸最小占短边的比例
PREVIEW_D, PREVIEW_PAD = 600, 40                              # 预览图里圆的直径、四周留边（像素）
BG, RING = (22, 16, 14), (50, 140, 255)                       # 预览底色、圆圈颜色（BGR）


def read_image(path):
    """读图（兼容中文路径），手机照片按拍摄方向转正，和浏览器显示的一致"""
    if not os.path.isfile(path):
        raise FileNotFoundError(f'找不到图片：{path}')
    img = cv2.imdecode(np.fromfile(path, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f'读不出图片：{path}')
    return img


def detect_face(img):
    """返回最大的一张脸 (左, 上, 宽, 高) 和认出几张脸"""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    m = int(min(gray.shape) * MIN_FACE)
    det = cv2.CascadeClassifier(cv2.data.haarcascades + CASCADE)
    faces = det.detectMultiScale(gray, SCALE_STEP, MIN_NEIGHBORS, minSize=(m, m))
    if len(faces) == 0:
        raise ValueError('照片里认不出正脸（侧脸、遮挡、太小，或不是真人照片）')
    return max(faces, key=lambda f: f[2] * f[3]), len(faces)


def square_of(face, w, h):
    """按标准算原图上的正方形 (左, 上, 边长)；放不下就取放得下的最大的，再把位置挪回原图里"""
    fx, fy, fw, fh = face
    cx, cy = fx + fw / 2, fy + fh / 2
    s = min(round(fw / FACE_W), w, h)
    x0 = min(max(round(cx - s / 2), 0), w - s)
    y0 = min(max(round(cy - FACE_Y * s), 0), h - s)
    return x0, y0, s


def save_preview(img, x0, y0, s, out):
    """把正方形缩到圆里，放在深色底上存成 PNG，给 AI 看裁得对不对"""
    sq = cv2.resize(img[y0:y0 + s, x0:x0 + s], (PREVIEW_D, PREVIEW_D), interpolation=cv2.INTER_AREA)
    n, r = PREVIEW_D + 2 * PREVIEW_PAD, PREVIEW_D // 2
    canvas = np.full((n, n, 3), BG, np.uint8)
    canvas[PREVIEW_PAD:PREVIEW_PAD + PREVIEW_D, PREVIEW_PAD:PREVIEW_PAD + PREVIEW_D] = sq
    mask = np.zeros((n, n), np.uint8)
    cv2.circle(mask, (n // 2, n // 2), r, 255, -1, cv2.LINE_AA)
    a = (mask / 255.0)[..., None]
    canvas = (canvas * a + np.array(BG) * (1 - a)).astype(np.uint8)
    cv2.circle(canvas, (n // 2, n // 2), r + 4, RING, 6, cv2.LINE_AA)
    cv2.imencode('.png', canvas)[1].tofile(out)


def main():
    print('==== 作者头像裁切 ====\n1. 算头像裁切（按脸的比例算出照片上要裁的正方形，出预览图）')
    ch = input('请选择: ').strip()
    if ch != '1':
        raise ValueError('编号无效')
    if not os.path.isdir(ENG):
        raise FileNotFoundError(f'当前目录（{WORK}）不是视频工作目录（没有 工程文件/）')
    rel = input('头像图片（相对工作目录的路径）: ').strip().strip('"')
    img = read_image(os.path.join(WORK, rel))
    h, w = img.shape[:2]
    face, count = detect_face(img)
    fx, fy, fw, fh = (int(v) for v in face)
    x0, y0, s = square_of((fx, fy, fw, fh), w, h)
    out = os.path.join(ENG, f'{os.path.splitext(os.path.basename(rel))[0]}_裁切预览.png')
    save_preview(img, x0, y0, s, out)
    if count > 1:
        print(f'照片里认出 {count} 张脸，按最大的一张算')
    print(f'原图 {w}×{h}，脸框 左 {fx} 上 {fy} 宽 {fw}')
    if s < round(fw / FACE_W):
        print('原图放不下标准大小的正方形，已取放得下的最大的')
    print(f'实际：脸宽占边长 {fw / s:.2f}，脸中心 横 {(fx + fw / 2 - x0) / s:.2f}、竖 {(fy + fh / 2 - y0) / s:.2f}')
    print(f'裁切正方形 [左, 上, 边长] = [{x0}, {y0}, {s}]')
    print(f'预览：{os.path.relpath(out, WORK).replace(os.sep, "/")}')


def run():
    """跑菜单，最后一行打印【结束】或【出错】（与 render.mjs 一致，调用方只认这两个判断跑完没有）"""
    try:
        main()
    except Exception as e:
        traceback.print_exc()
        print(f'【出错】{e}')
        sys.exit(1)
    print('【结束】')


if __name__ == '__main__':
    run()
