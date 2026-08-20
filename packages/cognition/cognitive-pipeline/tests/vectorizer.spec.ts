import { describe, expect, it } from 'vitest'
import {
  ACTION_VECTOR_DIM,
  OUTCOME_VECTOR_DIM,
  actionVector,
  cosine,
  isPositiveOutcome,
  outcomePolarity,
  outcomeVector,
  signatureHash,
  symptomOverlap,
  tokenize,
} from '../src/vectorizer.ts'

describe('vectorizer', () => {
  it('produces deterministic vectors with the declared dimensions', () => {
    const first = actionVector('晨跑五公里', ['晨跑', '运动'])
    const second = actionVector('晨跑五公里', ['晨跑', '运动'])
    expect(first).toEqual(second)
    expect(first).toHaveLength(ACTION_VECTOR_DIM)
    expect(outcomeVector({ materialGain: 8, emotionalValence: 7, energyCost: 3 }, '精力充沛')).toHaveLength(OUTCOME_VECTOR_DIM)
  })

  it('scores identical vectors at cosine 1 and keeps hashes stable', () => {
    const vector = actionVector('早起读书', [])
    expect(cosine(vector, vector)).toBeGreaterThan(0.999)
    expect(signatureHash('早起读书')).toBe(signatureHash('早起读书'))
    expect(signatureHash('早起读书')).not.toBe(signatureHash('熬夜刷剧'))
  })

  it('tokenizes CJK characters and latin runs', () => {
    expect(tokenize('晨跑5公里 RunFast')).toEqual(['晨', '跑', '5', '公', '里', 'runfast'])
  })

  it('clusters by utility pattern, not by outcome wording (utility first)', () => {
    const sameUtilityDifferentText = [
      outcomeVector({ materialGain: 8, emotionalValence: 7, energyCost: 3 }, '次日精力充沛效率极高'),
      outcomeVector({ materialGain: 8, emotionalValence: 7, energyCost: 3 }, '身体轻盈心情愉悦'),
    ]
    const sameTextDifferentUtility = [
      outcomeVector({ materialGain: 8, emotionalValence: 7, energyCost: 3 }, '精力充沛'),
      outcomeVector({ materialGain: 2, emotionalValence: 3, energyCost: 8 }, '精力充沛'),
    ]
    const utilityCos = cosine(sameUtilityDifferentText[0] ?? [], sameUtilityDifferentText[1] ?? [])
    const textCos = cosine(sameTextDifferentUtility[0] ?? [], sameTextDifferentUtility[1] ?? [])
    expect(utilityCos).toBeGreaterThan(0.5)
    expect(utilityCos).toBeGreaterThan(textCos + 0.5)
  })

  it('judges positive outcomes by the composite utility score', () => {
    expect(isPositiveOutcome({ materialGain: 8, emotionalValence: 7, energyCost: 3 })).toBe(true)
    expect(isPositiveOutcome({ materialGain: 2, emotionalValence: 2, energyCost: 8 })).toBe(false)
    expect(isPositiveOutcome({ materialGain: 5, emotionalValence: 5, energyCost: 5 })).toBe(false)
  })

  it('classifies outcomes into three polarities, never neutral as failure', () => {
    expect(outcomePolarity({ materialGain: 8, emotionalValence: 7, energyCost: 3 })).toBe('positive')
    expect(outcomePolarity({ materialGain: 2, emotionalValence: 2, energyCost: 8 })).toBe('negative')
    expect(outcomePolarity({ materialGain: 5, emotionalValence: 5, energyCost: 5 })).toBe('neutral')
    // A gain that exactly cancels its cost is neutral, not negative.
    expect(outcomePolarity({ materialGain: 7, emotionalValence: 5, energyCost: 7 })).toBe('neutral')
  })

  it('scores symptom overlap as the exact-substring recall channel', () => {
    const experience = '测试脚本挂起，发现浮点死循环'
    // The query's symptom markers are all present verbatim.
    expect(symptomOverlap('修复测试挂起问题', experience)).toBe(1)
    // A marker absent from the query is not counted.
    expect(symptomOverlap('修复测试挂起问题', '编译失败，无法构建')).toBe(0)
    // A query with two markers, one present: 1/2.
    expect(symptomOverlap('处理编译错误', experience)).toBe(0)
    expect(symptomOverlap('处理编译错误', '编译失败，报错')).toBe(0.5)
    // A query with no symptom markers scores 0, never a false hit.
    expect(symptomOverlap('实现新功能', '挂起')).toBe(0)
  })
})
