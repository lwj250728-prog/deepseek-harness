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
    ap.add_argument('--allow-empty', action='store_true', help='确要清空目标文件时显式声明')
    args = ap.parse_args()
    if not args.from_stdin:
        print("只支持 --from-stdin(避免把路径写成内容); 用法: some-cmd | python3 dsh-safe-write.py <path> --from-stdin")
        raise SystemExit(2)
    import sys as _sys
    text = _sys.stdin.read()
    # 2026-09-13 12:1x **实测事故(我自己造成的)**: 我用 `python3 dsh-safe-write.py --from-stdin < /tmp/x.json` 写
    # 豁免册, 而生成 /tmp/x.json 的那条命令**语法错、什么都没输出** ⇒ 空内容被原子写入 ⇒ 豁免册从 6 条变 0 字节,
    # T143 随后报 JSONDecodeError。原子写保护的是"写一半", 保护不了"写进去的是空的"。
    # 故: 目标是**已存在的非空文件**时, 空内容(或纯空白)一律拒写 —— 要真的清空必须显式 --allow-empty。
    existing = os.path.getsize(args.path) if os.path.exists(args.path) else 0
    if text.strip() == '' and existing > 0 and not getattr(args, 'allow_empty', False):
        print('拒绝: 新内容为空而目标是已存在的非空文件(%d 字节) —— 多半是上游命令失败没产出内容。'
              '确要清空请显式加 --allow-empty' % existing, file=_sys.stderr)
        raise SystemExit(3)
    safe_write(args.path, text)
    print("已安全写入 %s" % args.path)
