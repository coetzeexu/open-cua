/** Fixed mock messages. Decisions use the current page, never hard-coded offers. */
export interface DemoProduct {
  rank: number;
  title: string;
  url: string;
  viewed: boolean;
  detailTitle?: string;
}
export interface DemoTask {
  status: "running" | "succeeded" | "interrupted" | "blocked";
  stage: string;
  failure?: { code: string; operation?: string };
  products: DemoProduct[];
}
export function selectionUrl(snapshot: string): string {
  const match = snapshot.match(
    /link "分销选品中心"[^\n]*\n\s*- \/url: ([^\s]+)/,
  );
  if (!match) throw Error("未找到官网分销选品中心入口");
  const url = new URL(match[1]!);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "air.1688.com" ||
    !url.pathname.includes("/channel-fe/search/")
  )
    throw Error("分销入口与预期不符");
  return url.href;
}
export function topProducts(items: unknown): DemoProduct[] {
  if (!Array.isArray(items)) throw Error("没有商品结果");
  const seen = new Set<string>();
  const result: DemoProduct[] = [];
  for (const item of items) {
    if (!item || typeof item.title !== "string" || typeof item.url !== "string")
      continue;
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "detail.1688.com" ||
      !/^\/offer\/\d+\.html$/.test(url.pathname) ||
      seen.has(url.pathname) ||
      !item.title.trim()
    )
      continue;
    seen.add(url.pathname);
    result.push({
      rank: result.length + 1,
      title: item.title.trim().slice(0, 200),
      url: url.href,
      viewed: false,
    });
    if (result.length === 3) return result;
  }
  throw Error("搜索页尚未提供三个可查看的商品");
}
export async function run1688Demo(options: {
  task: DemoTask;
  signal: AbortSignal;
  execute: (code: string) => Promise<any>;
  progress: (stage: string) => void;
}) {
  const { task, signal, progress } = options;
  // This check brackets every cell, including the gaps between CUA executions.
  const execute = async (code: string) => {
    signal.throwIfAborted();
    const value = await options.execute(code);
    signal.throwIfAborted();
    return value;
  };
  const stage = (message: string) => {
    signal.throwIfAborted();
    task.stage = message;
    progress(message);
  };
  stage("打开 1688 官网，展开买家服务");
  await execute(
    `await tab.goto('https://www.1688.com/');await tab.waitForFunction(()=>{const roots=[document];for(const root of roots){for(const el of root.querySelectorAll('*')){if(el.shadowRoot)roots.push(el.shadowRoot);if(el.textContent==='买家服务'&&el.getClientRects().length)return true;}}return false;},{timeoutMs:25000});await tab.getByText('买家服务',{exact:true}).hover();await tab.waitForFunction(()=>{const roots=[document];for(const root of roots){for(const el of root.querySelectorAll('*')){if(el.shadowRoot)roots.push(el.shadowRoot);if(el.getAttribute('title')==='分销服务'&&el.getClientRects().length)return true;}}return false;},{timeoutMs:10000});await tab.locator('[title="分销服务"]').hover();`,
  );
  stage("从官网进入分销工作台 · 分销选品中心");
  const snapshot = await execute(
    `output.text(JSON.stringify((await tab.dom.snapshot()).frames.map(f=>f.text).join('\\n')));`,
  );
  const entry = selectionUrl(snapshot);
  await execute(
    `await tab.goto(${JSON.stringify(entry)});await tab.waitForFunction(()=>!!document.querySelector('input[type=search],input[role=searchbox]'),{timeoutMs:25000});await tab.getByRole('searchbox').fill('欧式灯具');await tab.getByRole('button',{name:'搜索',exact:true}).click();`,
  );
  stage("搜索欧式灯具，读取默认排序前三项");
  await execute(
    `await tab.waitForFunction(() => document.body.innerText.includes('已搜索关键词') && document.body.innerText.includes('欧式灯具') && document.querySelectorAll('a[href*="detail.1688.com/offer/"]').length >= 3,{timeoutMs:25000});`,
  );
  const items = await execute(
    `output.text(JSON.stringify(await tab.evaluate(() => Array.from(document.querySelectorAll('a[href*="detail.1688.com/offer/"]')).filter(a=>a.getClientRects().length).map(a=>({url:a.href,title:a.querySelector('p')?.innerText || a.querySelector('img')?.alt || a.innerText.split('\\n')[0]})))));`,
  );
  task.products = topProducts(items);
  for (const product of task.products) {
    stage(`查看第 ${product.rank}/3 项：${product.title}`);
    await execute(
      `await tab.goto(${JSON.stringify(product.url)});await tab.waitForFunction(() => document.body.innerText.includes(${JSON.stringify(product.title)}) && /立即下单|加采购车|商品详情/.test(document.body.innerText),{timeoutMs:25000});output.text(JSON.stringify(await tab.evaluate(()=>({title:document.title,url:location.href}))));`,
    );
    product.viewed = true;
    product.detailTitle = product.title;
  }
  stage("已查看前三项商品详情（搜索默认排序）");
  task.status = "succeeded";
}
