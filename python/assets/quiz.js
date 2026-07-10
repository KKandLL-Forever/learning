// 测验组件：即时反馈的单选题
// 用法：quiz(容器id, 题目, [选项...], 正确项下标, 解释)
function quiz(id, question, options, correctIndex, explain) {
  const root = document.getElementById(id);
  root.className = "quiz";
  const q = document.createElement("p");
  q.className = "q";
  q.textContent = question;
  root.appendChild(q);
  const fb = document.createElement("p");
  fb.className = "feedback";
  options.forEach((opt, i) => {
    const btn = document.createElement("button");
    btn.className = "opt";
    btn.textContent = opt;
    btn.onclick = () => {
      root.querySelectorAll("button").forEach(b => (b.disabled = true));
      btn.classList.add(i === correctIndex ? "correct" : "wrong");
      if (i !== correctIndex) root.children[1 + correctIndex].classList.add("correct");
      fb.textContent = (i === correctIndex ? "✓ 正确。" : "✗ 不对。") + explain;
    };
    root.appendChild(btn);
  });
  root.appendChild(fb);
}
