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
