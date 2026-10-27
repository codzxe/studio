#!/usr/bin/env python3
"""Post-process Studio docx: patch footer PAGE fields with explicit format switch,
remove empty <w:pgNumType/>, per toc.md WPS-compatibility rules."""
import re
import shutil
import sys
import zipfile
import tempfile
import os

DOCX = "/home/z/my-project/download/Studio\u9879\u76ee\u6587\u6863\u6458\u8981.docx"

def main():
    tmp_dir = tempfile.mkdtemp()
    tmp_path = os.path.join(tmp_dir, "out.docx")
    changed = {"footer": 0, "pgnum": 0}
    with zipfile.ZipFile(DOCX, "r") as zin:
        names = zin.namelist()
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for name in names:
                data = zin.read(name)
                if name == "word/document.xml":
                    xml = data.decode("utf-8")
                    n_before = xml.count("<w:pgNumType/>")
                    xml = xml.replace("<w:pgNumType/>", "")
                    changed["pgnum"] = n_before
                    data = xml.encode("utf-8")
                elif re.match(r"word/footer\d+\.xml", name):
                    xml = data.decode("utf-8")
                    # bare PAGE -> PAGE \* arabic \* MERGEFORMAT (body footer is the only footer)
                    new_xml, n = re.subn(
                        r"(<w:instrText[^>]*>)\s*PAGE\s*(</w:instrText>)",
                        r"\1 PAGE \\* arabic \\* MERGEFORMAT \2",
                        xml,
                    )
                    if n:
                        changed["footer"] += n
                        xml = new_xml
                    data = xml.encode("utf-8")
                zout.writestr(name, data)
    shutil.move(tmp_path, DOCX)
    print(f"patched footers={changed['footer']} removed_pgNumType={changed['pgnum']}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
