# Learning Record 0001: Agentic Loop is the Core of Every Harness

## Date

2026-07-10

## Context

Lesson 0001 introduced the concept of Harness Engineering and the Agentic Loop pattern.

## Insight

Every AI harness, from a 30-line script to Claude Code, is built on the same fundamental pattern: the Agentic Loop. The model receives input + tools, decides whether to output text or call a tool, and the loop continues until the model decides to stop. All the complexity of production harnesses (multi-agent, monitoring, error recovery) are layers on top of this core loop.

The 30-line TypeScript example demystifies harness engineering — it's not magic, it's a while-loop with structured tool definitions.

## Implications

- Future lessons can build incrementally on the 30-line core
- The user's existing experience with Claude Code gives them intuition for what the loop does
- Level 1 → Level 3 progression provides a clear learning path

## Related

- [Lesson 0001: What is Harness Engineering?](../lessons/0001-what-is-harness-engineering.html)