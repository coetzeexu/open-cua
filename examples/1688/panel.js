const $ = (id) => document.getElementById(id);
const button = document.createElement("button");
button.textContent = "运行 1688 演示";
button.disabled = true;
$("run").after(button);
document.querySelector("aside").insertAdjacentHTML(
  "afterbegin",
  `<section id="taskCard" class="card" hidden>
            <p class="eyebrow">1688 · MOCK MODEL</p>
            <h2>欧式灯具 · Top 3</h2>
            <p id="taskStage" class="note"></p>
            <ol id="products"></ol>
            <p class="note">
              按当前搜索默认排序，逐项查看详情。仅浏览，不下单；交还模型后可重新运行。
            </p>
          </section>`,
);
button.onclick = async () => {
  button.disabled = true;
  try {
    const response = await fetch("/api/scenario", {
      method: "POST",
      body: "{}",
    });
    if (!response.ok) throw Error((await response.json()).error);
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
  }
};
document.addEventListener("preview-state", ({ detail: s }) => {
  button.disabled = s.control !== "agent" || s.active;
  $("taskCard").hidden = !s.scenario;
  if (s.scenario) {
    $("taskStage").textContent = s.scenario.stage;
    $("products").replaceChildren(
      ...s.scenario.products.map((p) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = p.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = p.title;
        li.append(
          a,
          document.createTextNode(p.viewed ? " · 已查看" : " · 待查看"),
        );
        return li;
      }),
    );
  }
});
