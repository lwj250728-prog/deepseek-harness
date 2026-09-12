"""安全改文件: 先在内存里构造完整内容, 成功后才写; 且写用 temp+os.replace。
教训(2026-09-12 17:1x, 我亲手造成): `open(path,'w').write("\n".join(lines))` —— **open('w') 会先截断**,
参数求值失败(我那次 lines 里混进了一个 tuple ⇒ TypeError)时文件已经空了: 611 条断言的套件被清空,
靠 git 恢复。这与本帧给账本做的原子写是同一条原理, 而我在自己的编辑脚本里违反了它。"""
import os, sys

def safe_write(path, text):
    tmp = path + '.tmp-%d' % os.getpid()
    with open(tmp, 'w', encoding='utf8') as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    # **保留原文件的权限位**(2026-09-12 19:0x 实测教训): temp 文件默认 644, 直接 replace 会把可执行位抹掉 ——
    # 而 `dsh-cog-tests.sh` 是被 **cron 直接调用**的(不是 bash <file>), 于是它静默停止运行, 日志里只留一行
    # `/bin/sh: 1: ...: Permission denied`(18:17 那次就是)。工具必须保持"改内容不改权限"。
    if os.path.exists(path):
        try:
            os.chmod(tmp, os.stat(path).st_mode & 0o7777)
        except Exception:  # noqa: BLE001
            pass
    os.replace(tmp, path)



if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(description="安全改文件: 先构造内容再 temp+fsync+os.replace(绝不先截断)")
    ap.add_argument('path')
    ap.add_argument('--from-stdin', action='store_true')
    args = ap.parse_args()
    if not args.from_stdin:
        print("只支持 --from-stdin(避免把路径写成内容); 用法: some-cmd | python3 dsh-safe-write.py <path> --from-stdin")
        raise SystemExit(2)
    import sys as _sys
    safe_write(args.path, _sys.stdin.read())
    print("已安全写入 %s" % args.path)
