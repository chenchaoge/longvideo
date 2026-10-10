# -*- coding: utf-8 -*-
"""剪映草稿加解密（通用）：调用剪映自带 videoeditor.dll 里的 EncryptUtils 导出函数
剪映 6.0 起草稿的 draft_content.json、draft_meta_info.json 是密文（AES-GCM，密钥在 dll 里，外面算不出来），
所以不自己解，直接让剪映自己的 dll 来加解密；做法来自 github.com/wenshui330/jy-draftc（MIT），用 Python ctypes 调同样的三个函数
剪映 11.5.0 实测可用；以后剪映改了函数名或加密方式，按 references/剪映加解密.md 调查，修好后改这个文件"""
import ctypes
import os
import re
import struct
import winreg

UNINSTALL_KEY = r'Software\Microsoft\Windows\CurrentVersion\Uninstall\JianyingPro'   # 注册表里剪映的安装信息
DLL = 'videoeditor.dll'
SYM_DEC = ('?decrypt@EncryptUtils@lvve@@QEAA?AV?$basic_string@DU?$char_traits@D@std@@'
           'V?$allocator@D@2@@std@@AEBV34@0AEA_N@Z')
SYM_ENC = ('?encrypt@EncryptUtils@lvve@@QEAA?AV?$basic_string@DU?$char_traits@D@std@@'
           'V?$allocator@D@2@@std@@AEBV34@@Z')
SYM_ENABLE = '?enable@EncryptUtils@lvve@@QEAAX_N@Z'
TEST_TEXT = '{"剪映加解密自检": "0123456789abcdef"}'


class CryptoError(Exception):
    """加解密用不了：剪映没装、dll 加载不了、函数名改了、解出来不对"""


def uninstall_value(name):
    """注册表里剪映卸载信息的某一项（如 UninstallString、DisplayVersion），没有返回 None"""
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(hive, UNINSTALL_KEY) as k:
                return str(winreg.QueryValueEx(k, name)[0])
        except OSError:
            continue
    return None


def install_dir():
    """剪映当前版本的目录（带 videoeditor.dll）：安装根目录 = 注册表里卸载程序所在的目录；
    版本目录优先用注册表登记的版本号，没有就取版本号最大的"""
    s = uninstall_value('UninstallString')
    if not s:
        raise CryptoError('注册表里没有剪映专业版的安装信息：电脑上没装剪映专业版')
    root = os.path.dirname(s.strip().strip('"'))
    ver = uninstall_value('DisplayVersion')
    if ver and os.path.isfile(os.path.join(root, ver, DLL)):
        return os.path.join(root, ver)
    vers = [d for d in os.listdir(root) if re.fullmatch(r'\d+(\.\d+)*', d) and os.path.isfile(os.path.join(root, d, DLL))]
    if not vers:
        raise CryptoError(f'剪映安装目录 {root} 里没有带 {DLL} 的版本目录')
    return os.path.join(root, max(vers, key=lambda d: tuple(map(int, d.split('.')))))


def exports(path, word='EncryptUtils'):
    """dll 导出函数里名字带 word 的（原来的函数名找不到时，用来看剪映改成了什么名字）"""
    b = open(path, 'rb').read()
    pe = struct.unpack_from('<I', b, 0x3C)[0]
    nsec, optsize = struct.unpack_from('<H', b, pe + 6)[0], struct.unpack_from('<H', b, pe + 20)[0]
    opt = pe + 24
    ddir = opt + (112 if struct.unpack_from('<H', b, opt)[0] == 0x20B else 96)   # 64 位和 32 位的数据目录位置不同
    secs = [struct.unpack_from('<IIII', b, opt + optsize + i * 40 + 8) for i in range(nsec)]   # 虚拟大小、虚拟地址、文件里大小、文件里位置

    def off(rva):
        for vs, va, rs, rp in secs:
            if va <= rva < va + max(vs, rs):
                return rva - va + rp
        raise CryptoError(f'{path} 的导出表读不出来')

    exp = off(struct.unpack_from('<I', b, ddir)[0])
    n, names = struct.unpack_from('<I', b, exp + 24)[0], off(struct.unpack_from('<I', b, exp + 32)[0])
    out = []
    for i in range(n):
        p = off(struct.unpack_from('<I', b, names + 4 * i)[0])
        name = b[p:b.index(b'\0', p)].decode('ascii', 'replace')
        if word.lower() in name.lower():
            out.append(name)
    return out


class MsvcString(ctypes.Structure):
    """MSVC 的 std::string 在 64 位下的内存布局：16 字节（短串直接放这里，长串放指针）+ 长度 + 容量"""
    _fields_ = [('buf', ctypes.c_ubyte * 16), ('size', ctypes.c_uint64), ('capacity', ctypes.c_uint64)]


def _make(data):
    """bytes 装成 std::string；返回 (结构, 要保活的缓冲)"""
    s = MsvcString()
    s.size = len(data)
    if len(data) < 16:
        ctypes.memmove(s.buf, data, len(data))
        s.capacity = 15
        return s, None
    hold = ctypes.create_string_buffer(data, len(data) + 1)
    ctypes.memmove(s.buf, ctypes.byref(ctypes.c_uint64(ctypes.cast(hold, ctypes.c_void_p).value)), 8)
    s.capacity = len(data)
    return s, hold


def _take(s):
    """从 std::string 里取出 bytes"""
    if s.size == 0:
        return b''
    if s.capacity < 16:
        return bytes(bytearray(s.buf)[:s.size])
    return ctypes.string_at(int.from_bytes(bytearray(s.buf)[:8], 'little'), s.size)


class JyCrypto:
    """加解密器（bytes 进 bytes 出）；建好时自检一次，过不了报 CryptoError"""

    def __init__(self):
        self.dir = install_dir()
        path = os.path.join(self.dir, DLL)
        try:
            os.add_dll_directory(self.dir)                     # 它依赖的 dll 从剪映安装目录找
            self.dll = ctypes.CDLL(path, winmode=0x00001100)
        except OSError as e:
            raise CryptoError(f'加载不了 {path}：{e}')
        try:
            self._dec, self._enc, self._enable = (getattr(self.dll, s) for s in (SYM_DEC, SYM_ENC, SYM_ENABLE))
        except AttributeError:
            found = exports(path)
            raise CryptoError(f'{path} 里找不到原来的加解密函数，剪映可能改了函数名；名字带 EncryptUtils 的导出函数：'
                              + ('\n  ' + '\n  '.join(found) if found else '一个都没有'))
        p = ctypes.POINTER(MsvcString)
        self._dec.restype, self._dec.argtypes = ctypes.c_void_p, [ctypes.c_void_p, p, p, p, ctypes.POINTER(ctypes.c_bool)]
        self._enc.restype, self._enc.argtypes = ctypes.c_void_p, [ctypes.c_void_p, p, p]
        self._enable.restype, self._enable.argtypes = None, [ctypes.c_void_p, ctypes.c_bool]
        self.check()

    def decrypt(self, data):
        """密文 → 明文；本来就是明文（{ 或 [ 开头）原样返回；解不出 JSON 报 CryptoError"""
        if data[:1] in (b'{', b'['):
            return data
        inp, _h1 = _make(data)
        par, _h2 = _make(b'{}')
        out, ok = MsvcString(), ctypes.c_bool(False)
        self._dec(None, ctypes.byref(out), ctypes.byref(inp), ctypes.byref(par), ctypes.byref(ok))
        plain = _take(out)
        if not ok.value or plain[:1] not in (b'{', b'['):
            raise CryptoError('解密失败：剪映可能换了加密方式')
        return plain

    def encrypt(self, data):
        """明文 → 密文（同样的内容每次加密出来都不一样，解回来一样）"""
        self._enable(None, True)
        inp, _h = _make(data)
        out = MsvcString()
        self._enc(None, ctypes.byref(out), ctypes.byref(inp))
        return _take(out)

    def check(self):
        """自检：加密一段文字再解回来要一字不差，且加密后不是明文"""
        t = TEST_TEXT.encode('utf-8')
        e = self.encrypt(t)
        if not e or e[:1] in (b'{', b'[') or self.decrypt(e) != t:
            raise CryptoError('自检没过：加密再解密对不上')
