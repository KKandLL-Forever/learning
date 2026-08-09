/*
 * quiz.js — 可复用的测验组件（Claude Code 源码架构课程）
 *
 * 设计目标：即时反馈的检索练习（retrieval practice）。
 * 答对答错都立刻给出解释，因为「答错后马上看到正确解释」比「只看到对错」
 * 更能建立 storage strength。
 *
 * 用法：
 *   <div class="quiz" id="q1"></div>
 *   <script src="../assets/quiz.js"></script>
 *   <script>
 *     Quiz.render('#q1', [
 *       { q: '题干', options: ['选项一', '选项二'], answer: 0, explain: '解释' },
 *       { q: '题干', recall: true, reveal: '参考答案' },   // 自由回忆题
 *     ])
 *   </script>
 *
 * 注意：选项文字应尽量等长，避免长度本身泄露答案。
 */
(function (global) {
  'use strict'

  const STYLE_ID = 'quiz-component-styles'

  const CSS = `
.quiz { margin: 1.5rem 0; }
.quiz-q {
  font-family: var(--font-sans);
  font-weight: 700;
  margin: 1.5rem 0 0.75rem;
  line-height: 1.5;
}
.quiz-q .quiz-num {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  color: var(--bg);
  background: var(--text-secondary);
  border-radius: 3px;
  padding: 0.08rem 0.4rem;
  margin-right: 0.5rem;
  vertical-align: 0.1em;
}
.quiz-opts { display: flex; flex-direction: column; gap: 0.45rem; }
.quiz-opt {
  font-family: var(--font-sans);
  font-size: 0.94rem;
  text-align: left;
  background: var(--code-bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.6rem 0.85rem;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
  line-height: 1.5;
}
.quiz-opt:hover:not(:disabled) { border-color: var(--accent-2); }
.quiz-opt:disabled { cursor: default; opacity: 0.75; }
.quiz-opt.is-correct   { border-color: var(--ok);     background: color-mix(in srgb, var(--ok) 12%, var(--code-bg)); opacity: 1; }
.quiz-opt.is-wrong     { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--code-bg)); opacity: 1; }
.quiz-mark { font-family: var(--font-mono); font-weight: 700; margin-right: 0.5rem; }

.quiz-feedback {
  margin-top: 0.7rem;
  padding: 0.7rem 0.9rem;
  border-radius: 4px;
  background: var(--highlight);
  border-left: 3px solid var(--warn);
  font-size: 0.92rem;
  line-height: 1.65;
}
.quiz-feedback strong { font-family: var(--font-sans); }

.quiz-recall textarea {
  width: 100%;
  min-height: 5.5rem;
  font-family: var(--font-body);
  font-size: 0.95rem;
  line-height: 1.6;
  color: var(--text);
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.6rem 0.8rem;
  resize: vertical;
}
.quiz-recall textarea:focus { outline: none; border-color: var(--accent-2); }
.quiz-reveal-btn {
  font-family: var(--font-sans);
  font-size: 0.88rem;
  margin-top: 0.5rem;
  background: none;
  color: var(--accent);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.35rem 0.8rem;
  cursor: pointer;
}
.quiz-reveal-btn:hover { border-color: var(--accent); }
.quiz-hint { font-size: 0.85rem; color: var(--text-secondary); margin-top: 0.4rem; font-family: var(--font-sans); }

.quiz-score {
  font-family: var(--font-sans);
  font-size: 0.92rem;
  margin-top: 1.5rem;
  padding: 0.7rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-secondary);
}
.quiz-score.done { border-color: var(--ok); color: var(--text); }

@media print {
  .quiz-opt { opacity: 1 !important; }
  .quiz-feedback, .quiz-reveal { display: block !important; }
  .quiz-reveal-btn, .quiz-score { display: none; }
}
`

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = CSS
    document.head.appendChild(el)
  }

  const LETTERS = 'ABCDEFGH'

  function renderChoice(item, index, onGraded) {
    const wrap = document.createElement('div')

    const q = document.createElement('p')
    q.className = 'quiz-q'
    q.innerHTML = `<span class="quiz-num">${String(index + 1).padStart(2, '0')}</span>${item.q}`
    wrap.appendChild(q)

    const opts = document.createElement('div')
    opts.className = 'quiz-opts'

    const feedback = document.createElement('div')
    feedback.className = 'quiz-feedback'
    feedback.style.display = 'none'

    const buttons = item.options.map((text, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'quiz-opt'
      b.innerHTML = `<span class="quiz-mark">${LETTERS[i]}</span>${text}`
      b.addEventListener('click', () => {
        const correct = i === item.answer
        buttons.forEach((other, j) => {
          other.disabled = true
          if (j === item.answer) other.classList.add('is-correct')
          else if (j === i) other.classList.add('is-wrong')
        })
        feedback.innerHTML =
          `<strong>${correct ? '答对了。' : '再想想 —— 正确答案是 ' + LETTERS[item.answer] + '。'}</strong> ` +
          item.explain
        feedback.style.display = ''
        onGraded(correct)
      })
      opts.appendChild(b)
      return b
    })

    wrap.appendChild(opts)
    wrap.appendChild(feedback)
    return wrap
  }

  function renderRecall(item, index, onGraded) {
    const wrap = document.createElement('div')
    wrap.className = 'quiz-recall'

    const q = document.createElement('p')
    q.className = 'quiz-q'
    q.innerHTML = `<span class="quiz-num">${String(index + 1).padStart(2, '0')}</span>${item.q}`
    wrap.appendChild(q)

    const ta = document.createElement('textarea')
    ta.placeholder = '先凭记忆写下来，再点下面按钮对照。'
    wrap.appendChild(ta)

    const hint = document.createElement('p')
    hint.className = 'quiz-hint'
    hint.textContent = '先写再看 —— 想不起来的挣扎本身就是记忆在变牢固。'
    wrap.appendChild(hint)

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'quiz-reveal-btn'
    btn.textContent = '对照参考答案'
    wrap.appendChild(btn)

    const reveal = document.createElement('div')
    reveal.className = 'quiz-feedback quiz-reveal'
    reveal.style.display = 'none'
    reveal.innerHTML = item.reveal
    wrap.appendChild(reveal)

    btn.addEventListener('click', () => {
      reveal.style.display = ''
      btn.disabled = true
      btn.style.display = 'none'
      onGraded(true)
    })

    return wrap
  }

  function render(selector, items) {
    injectStyles()
    const root =
      typeof selector === 'string' ? document.querySelector(selector) : selector
    if (!root) {
      console.warn('[quiz] 找不到容器：', selector)
      return
    }

    const gradable = items.filter((it) => !it.recall).length
    let answered = 0
    let correct = 0

    const score = document.createElement('div')
    score.className = 'quiz-score'

    function updateScore() {
      if (gradable === 0) return
      score.textContent = `已作答 ${answered} / ${gradable}　正确 ${correct}`
      if (answered === gradable) {
        score.classList.add('done')
        score.textContent += correct === gradable ? '　—— 全对，可以进下一课了。' : '　—— 答错的那题回到正文重读一遍。'
      }
    }

    items.forEach((item, i) => {
      const onGraded = (isCorrect) => {
        if (item.recall) return
        answered += 1
        if (isCorrect) correct += 1
        updateScore()
      }
      root.appendChild(
        item.recall ? renderRecall(item, i, onGraded) : renderChoice(item, i, onGraded),
      )
    })

    if (gradable > 0) {
      updateScore()
      root.appendChild(score)
    }
  }

  global.Quiz = { render }
})(window)
