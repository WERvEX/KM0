import { describe, expect, it } from "vitest";
import { normalizeReleaseNotes } from "./release-notes";

describe("normalizeReleaseNotes", () => {
  it("converts GitHub HTML release notes into clean Markdown without raw HTML tags", () => {
    const html = `
      <p>KM0 1.2 release overview.</p>
      <h2>新功能</h2>
      <ul>
        <li><strong>已有项目快速规划与深度仓库扫描</strong>：
          <ul>
            <li>关联本地仓库时自动扫描 <code>CLAUDE.md</code> 与脚本。</li>
          </ul>
        </li>
        <li><strong>最终集成分支</strong>：保存至 <code>handoffs/&lt;NN&gt;.json</code>。</li>
      </ul>
      <h2>下载</h2>
      <table>
        <thead><tr><th>平台</th><th>文件</th></tr></thead>
        <tbody>
          <tr><td>Windows (x64)</td><td><code>KM0-1.2.0-setup-x64.exe</code></td></tr>
        </tbody>
      </table>
      <p>网页版：<a href="https://wervex.github.io/KM0/" rel="nofollow">https://wervex.github.io/KM0/</a></p>
      <blockquote><p>本次发布的安装包签名情况：Windows 未签名。</p></blockquote>
    `;

    const md = normalizeReleaseNotes(html);
    expect(md).not.toMatch(/<\/?(ul|li|p|h2|table|blockquote|code|strong)>/i);
    expect(md).toContain("## 新功能");
    expect(md).toContain("- **已有项目快速规划与深度仓库扫描**：");
    expect(md).toContain("  - 关联本地仓库时自动扫描 `CLAUDE.md` 与脚本。");
    expect(md).toContain("`handoffs/<NN>.json`");
    expect(md).toContain("| 平台 | 文件 |");
    expect(md).toContain("| Windows (x64) | `KM0-1.2.0-setup-x64.exe` |");
    expect(md).toContain("[https://wervex.github.io/KM0/](https://wervex.github.io/KM0/)");
    expect(md).toContain("> 本次发布的安装包签名情况：Windows 未签名。");
  });

  it("passes plain Markdown through unchanged even with angle-bracket placeholders in code spans", () => {
    const md = "KM0 1.0.1\n\n- Fixes `km0/<run_id>/final` integration.";
    expect(normalizeReleaseNotes(md)).toBe(md);
  });

  it("drops unsafe scripts/frames and neutralizes non-http links", () => {
    const html = `<p>Safe <a href="javascript:void(0)">click</a></p><script>window.xss = 1</script><iframe src="https://evil.example"></iframe>`;
    const md = normalizeReleaseNotes(html);
    expect(md).toBe("Safe click");
    expect(md).not.toContain("javascript:");
    expect(md).not.toContain("window.xss");
    expect(md).not.toContain("iframe");
  });
});
