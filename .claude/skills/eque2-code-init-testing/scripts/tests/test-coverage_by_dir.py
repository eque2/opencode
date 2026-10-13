"""Merge an lcov and a Cobertura report and check the per-directory numbers a plan relies on."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "coverage_by_dir.py"

LCOV = """TN:
SF:web/src/cart/total.ts
LF:10
LH:9
BRF:4
BRH:2
end_of_record
SF:web/src/cart/empty.ts
LF:5
LH:0
end_of_record
"""

COBERTURA = """<?xml version="1.0"?>
<coverage><sources><source>{root}/api</source></sources>
<packages><package name="Api"><classes>
<class name="Api.Invoice" filename="Billing/Invoice.cs">
  <methods><method name="Total"><lines>
    <line number="3" hits="1" branch="True" condition-coverage="50% (1/2)" />
  </lines></method></methods>
  <lines>
    <line number="3" hits="1" branch="True" condition-coverage="50% (1/2)" />
    <line number="4" hits="0" branch="False" />
  </lines>
</class>
</classes></package></packages></coverage>
"""


def test_merges_lcov_and_cobertura_by_directory():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()
        (root / "lcov.info").write_text(LCOV)
        (root / "coverage.cobertura.xml").write_text(COBERTURA.format(root=root))
        out = subprocess.run(
            [sys.executable, str(SCRIPT), "lcov.info", "coverage.cobertura.xml", "--root", str(root), "--depth", "2"],
            cwd=root, capture_output=True, text=True, check=True)
        d = json.loads(out.stdout)
    assert d["directories"]["web/src"]["lines"] == {"covered": 9, "total": 15, "pct": 60.0}
    assert d["directories"]["web/src"]["branches"] == {"covered": 2, "total": 4, "pct": 50.0}
    # Line 3 appears under both <method> and <class>; it counts once.
    assert d["directories"]["api/Billing"]["lines"] == {"covered": 1, "total": 2, "pct": 50.0}
    assert d["directories"]["api/Billing"]["branches"] == {"covered": 1, "total": 2, "pct": 50.0}
    assert d["totals"]["lines"] == {"covered": 10, "total": 17, "pct": 58.82}
    assert d["files_at_zero"] == ["web/src/cart/empty.ts"]
    assert list(d["directories"]) == ["api/Billing", "web/src"], "worst-covered directory comes first"


def test_missing_report_exits_2():
    out = subprocess.run([sys.executable, str(SCRIPT), "/no/such/lcov.info"], capture_output=True, text=True)
    assert out.returncode == 2


if __name__ == "__main__":
    test_merges_lcov_and_cobertura_by_directory()
    test_missing_report_exits_2()
    print("ok")
