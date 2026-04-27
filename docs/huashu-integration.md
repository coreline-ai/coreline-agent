# 디자인 레퍼런스 통합 가이드

> coreline-agent는 [디자인 레퍼런스](https://github.com//디자인 레퍼런스) 의 디자인 철학·프레임워크에서 **개념적 영감**을 받지만, 디자인 레퍼런스 자체를 번들링하지 않습니다.

## ⚠️ 라이선스 안내

디자인 레퍼런스은 **** 라이선스입니다:

| 사용 형태 | 가능 여부 |
|---------|---------|
| 개인 학습 / 사이드 프로젝트 / 콘텐츠 창작 | ✅ 자유 |
| **회사/팀 내부 도구로 통합** | ❌ 서면 승인 필수 |
| 클라이언트 납품 / B2B SaaS | ❌ 승인 필수 |
| **개념·패턴 영감으로 자체 구현** | ✅ 자유 (저작권 외) |

**상업 라이선스 문의**: (X/Twitter)

## 통합 형태

coreline-agent에는 **2가지 방식**으로 디자인 레퍼런스을 활용할 수 있습니다:

### 방식 1: 외부 skill로 별도 설치 (권장, R1)

`~/.claude/skills/`에 디자인 레퍼런스을 설치하면, **외부 에이전트**(Claude Code, Cursor 등)에서 호출할 수 있습니다. coreline-agent 자체는 디자인 레퍼런스 코드를 포함하지 않습니다.

```bash
# coreline-agent 저장소 루트에서:
bash scripts/install-디자인 레퍼런스-skill.sh

# 확인:
ls -la ~/.claude/skills/디자인 레퍼런스/SKILL.md
```

설치 옵션:
- **Symlink**: 기존 로컬 clone이 있으면 자동 symlink (권장)
- **Git clone**: 없으면 GitHub에서 fresh clone

환경변수 override:
```bash
HUASHU_DESIGN_PATH=/custom/path/디자인 레퍼런스 bash scripts/install-디자인 레퍼런스-skill.sh
```

설치 후 Claude Code/Cursor 등에서:
```
> 디자인 레퍼런스 스킬을 사용해서 coreline-agent 런칭 슬라이드 만들어줘
```

### 방식 2: 개념 차용된 자체 구현 (R2-R4)

coreline-agent는 디자인 레퍼런스의 **개념·패턴**을 자체 재구현한 4개 기능을 내장합니다:

| 기능 | 슬래시 명령 | 영감 출처 |
|------|----------|----------|
| **Brand Spec memory type** | `/memory brand-spec init|view|edit <name>` | 디자인 레퍼런스의 core asset protocol |
| **5차원 Critique 프레임워크** | `/critique <path> [--philosophy NAME]` | 디자인 레퍼런스의 critique-guide.md |
| **Anti-AI-slop detector** | `/slop-check <path>` + PostTool hook | 디자인 레퍼런스의 content-guidelines.md |

각 모듈은 **독자 작성**이며 디자인 레퍼런스 텍스트를 직접 복사하지 않습니다 (저작권 안전).

## Design Philosophy Experiments (선택적)

Phase 5에서 추가된 **5개 design philosophy fixture**는 prompt experiment 카탈로그로 활용할 수 있습니다. 디자인 레퍼런스의 20개 디자인 유파 중 5개(Pentagram, Kenya Hara, Sagmeister & Walsh, Field.io, Takram)에서 영감을 받아, 각각을 **코딩/문서 작성 원칙**으로 재해석한 prompt variant입니다.

### 사용법

자동 등록되지 않습니다. 명시적으로 호출해야 합니다 (sub-agent 부작용 방지):

```typescript
import { registerDesignPhilosophyExperiment } from "coreline-agent/agent/self-improve/prompt-experiment-fixtures";

// 한 번 등록:
registerDesignPhilosophyExperiment;

// 이후 TUI에서:
// /prompt experiment design-philosophy --runs 5
```

### 5 fixture 요약

| id | 카테고리 | 적합 작업 |
|----|---------|----------|
| `pentagram-systematic` | system | technical-spec, api-reference, ADR |
| `kenya-hara-emptiness` | minimalism | readme, philosophy-document |
| `sagmeister-warm-minimal` | minimalism | tutorial, blog-post, error-message |
| `field-io-generative` | generative | algorithm-design, config-DSL |
| `takram-diagrammatic` | diagrammatic | architecture-doc, state-machine-spec |

### 라이선스 안전성

- 디자인 레퍼런스 `references/design-styles.md` 텍스트는 **0% 복사**되지 않았습니다.
- 파일 헤더 attribution + 자동 license 검증 테스트(`tests/design-philosophy-fixtures.test.ts`)로 보호됩니다.

### 주의 — Conceptual mismatch 위험

디자인 철학을 코딩 작업에 적용하는 것은 **개념적 부정합** 위험이 있습니다. 본 fixture는 **자동 활성화되지 않으며**, 사용자가 명시적으로 등록하여 prompt experiment로 사용하는 것을 전제로 합니다.

## 참고 / 출처 표기

이 통합은 다음의 디자인 레퍼런스 자료에서 **개념적 영감**을 받았습니다:

- `SKILL.md` §1.a "핵심 자산 협약" → Brand Spec memory type
- `references/critique-guide.md` → 5차원 critique framework
- `references/content-guidelines.md` → Anti-AI-slop detector

모든 신규 모듈 파일 헤더에 attribution 주석을 일관되게 명시:

```typescript
/**
 * <module purpose> — concept inspired by 디자인 레퍼런스.
 * https://github.com//디자인 레퍼런스 (Personal Use License)
 * Implementation written independently.
 */
```

## 사용 시나리오

### 시나리오 1: 신규 프로젝트 brand-spec 정의

```bash
# coreline-agent TUI에서:
/memory brand-spec init my-project

# 자동 생성된 templates를 편집 후:
/memory brand-spec view my-project

# 이후 모든 시스템 프롬프트에 brand-spec이 자동 포함됨 (tier: core)
```

### 시나리오 2: 외부 에이전트로 발표 슬라이드 제작

```bash
# (~/.claude/skills/디자인 레퍼런스 설치 후 — 방식 1)
# Claude Code 또는 Cursor에서:
> coreline-agent의 README를 디자인 레퍼런스 스킬로 발표 슬라이드 만들어줘
```

### 시나리오 3: 자가 평가 + slop 검출

```bash
# coreline-agent로 작성한 디자인 문서 평가 (5차원 critique):
# - philosophy / visual-hierarchy / craft / functionality / originality
# - 기본은 LLM 전략 (claude-haiku-4-5-20251001), 실패 시 heuristic fallback
/critique design.html --philosophy minimal

# 강제로 heuristic 전략만 사용:
/critique design.html --strategy heuristic

# 환경변수 opt-out (heuristic 강제):
CRITIQUE_LLM_ENABLED=false

# 출력에서 AI slop 패턴 자동 감지:
/slop-check design.html
```

## 참조 문서

- 디자인 레퍼런스 본가: <https://github.com//디자인 레퍼런스>
- coreline-agent 통합 dev-plan: [implement_20260426_090000.md](../dev-plan/implement_20260426_090000.md)
- 메모리 시스템 (brand-spec 포함): [memory-system.md](memory-system.md)

## 변경 이력

- 2026-04-26: 초안 — Phase 0 (R1 install + docs) 완료
- 2026-04-26: Phase 5 — 5 design-philosophy prompt experiment fixture 추가
- 2026-04-26: Phase 2 (R4) — 5차원 critique framework 구현 (`/critique` 명령, LLM + heuristic fallback)
