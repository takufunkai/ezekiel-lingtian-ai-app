Project 3: AI app
Build one useful LLM application as a team

Work as a team. Build one small app that uses an LLM. Use at least three techniques from this course.

From idea to action

HADR was the worked example. Your app does not need to use the HADR theme. Your app also does not need an agent loop. Use the simplest design that solves the problem.

Requirements
Your app must have:

one clear use case;
one complete input-to-output path;
one useful task for the LLM;
at least three course techniques;
one shared repository; and
tests or examples that show the result.
Use the LLM for a task that simple parsing or a fixed template cannot do. Do not add an agent loop only to make the app look more advanced.

What Claude implements
Claude helps you:

compare possible app ideas;
write a small PRD.md;
plan the minimum complete app;
implement the app in small steps;
add three test examples; and
prepare a short README.md.
You approve the idea, scope, and three techniques before Claude writes code.

Work as a team
Build the minimum input-to-output path first. Then divide the remaining work into independent features.

For each feature, define:

one owner;
the files or interface that the feature can change;
one acceptance check; and
its dependencies on other features.
Use a separate branch for each feature. Consider a separate Claude Code worktree for each branch. A worktree gives each feature its own working directory. This lets team members and Claude sessions work in parallel without changing the same checkout.

Review each feature before you merge it. Merge features one at a time. Run the complete test set after each merge.

Find an idea with Claude
Project 1 already used a full product interview. For this project, choose and scope the team idea quickly. Open a new Claude Code conversation and paste:

We are ______. Help us choose a small app that uses an LLM.

Give us three ideas from our work or interests. Do not assume that the app must be a chatbot or an agent. For each idea, list:

the user;
the input;
the output;
the useful task for the LLM;
the smallest complete demonstration;
three suitable course techniques; and
the main failure risk.
Recommend one based on usefulness, clear scope, and ease of demonstration. Ask only the questions needed to distinguish the three ideas.

After we choose, write a one-page PRD.md with the problem, input-to-output path, one example input and output, acceptance criteria, three test examples, non-goals, and the three course techniques.

End by asking what we can remove. Do not add features that we cannot demonstrate.

Choose a small idea. Remove features until one complete path remains.

Examples:

engineering notes into a structured fault or test record;
logs and test results into a technical brief;
requirements into review questions or acceptance criteria;
code or configuration into an explanation or risk report;
several conflicting updates into a cited summary;
a tool that collects evidence before it recommends an action; or
an evaluation app for a model task.
You can choose a different idea.

Choose three techniques
Choose techniques that help the app.

Model techniques
structured output;
prompt and context design;
tools, APIs, MCP, or skills;
an agent loop when one result controls the next step;
model comparison; or
token and cache design.
Evaluation and control techniques
code validation of model output;
source citations;
human approval before an important action;
evaluation examples and scores;
before-and-after prompt tests; or
independent review with a subagent.
Software engineering techniques
a PRD and acceptance criteria;
tests, types, and linting;
small implementation steps; or
code review.
At least one technique must control how the app uses the LLM. At least one technique must test or constrain the model. The use of Claude to write code is not one of the three techniques.

Prompt Claude to plan the team build
Create the project. Start a new Claude Code conversation. Paste:

Read PRD.md and inspect this repository. Do not write code yet.

Show the smallest complete input-to-output path. Show where each of the three course techniques belongs. For each technique, state the evidence that will show that it is useful.

Propose a short plan. Make one test example work from start to finish before you add other features. Then divide the remaining work into independent features for the team.

For each feature, list the files or interfaces that it can change, one acceptance check, and its dependencies. Put this plan in TEAM_PLAN.md. Warn us about features that can cause merge conflicts.

Keep prompts in separate files. Keep deterministic validation outside the model. Do not add an agent loop unless one result must control the next tool call or model call.

Show me the plan and wait for approval.

After approval, implement one small step at a time. Run the relevant check after each step. Run all three test examples. Show the first important failure before you fix it. Make one improvement that has before-and-after evidence.

Do not add authentication, deployment, or external integrations unless the main path needs them.

At the end, write a short README.md. Include setup, demonstration steps, the three techniques, the evidence for each technique, known limits, and the next safe improvement.

Review Claude’s work. Inspect the raw model input and output. Ask Claude to explain code that you do not understand.

Build features in parallel
After the minimum path works, create one branch and worktree for each approved feature. Start a separate Claude Code conversation in each worktree. Paste:

Read PRD.md and TEAM_PLAN.md. Implement only this feature: ______.

Follow the approved file and interface boundary. Do not change another feature’s files unless the interface cannot work. If you find such a problem, stop and explain it before you edit.

Run this feature’s acceptance check. Summarize the files changed, the evidence, and any integration risk. Do not merge the branch.

Review the feature branch. Then merge it through the team’s normal review process.

Check the result
Your project is complete when:

one input-to-output path works;
all three test examples run;
the repository contains PRD.md, TEAM_PLAN.md, and README.md;
the app uses three course techniques;
the team has reviewed and integrated its feature branches;
at least one improvement has before-and-after evidence; and
you can explain what the model does and what code checks.
