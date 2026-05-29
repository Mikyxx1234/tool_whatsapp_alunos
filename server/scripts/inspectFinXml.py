import zipfile
import re

p = r"C:\Users\Raphael Castro\Downloads\Alunos com mensalidade em aberto.xlsx"
with zipfile.ZipFile(p) as z:
    xml = z.read("xl/worksheets/sheet1.xml").decode("utf-8", "ignore")

idx = xml.find("27498590")
print(xml[idx - 200 : idx + 500])

m = re.search(r'<c r="A2"[^>]*>.*?</c>', xml)
print("\nA2 tag:", m.group() if m else "NOT FOUND")

rows = re.findall(r"<x:row[^>]*>(.*?)</x:row>", xml, re.DOTALL)
print("\nrow count", len(rows))
if len(rows) > 1:
    print("row1 (first data?) len", len(rows[1]))
    print(rows[1][:600])
