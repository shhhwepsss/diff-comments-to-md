import { describe, expect, it } from 'vitest';
import { routeFromHash } from './hash';
import { PRODUCT_NAME, repoName, titleFor } from './title';

const titleOf = (hash: string) => titleFor(routeFromHash(hash));

describe('заголовок окна', () => {
  it('открытый локальный репозиторий подписан именем своей папки', () => {
    expect(titleOf('#/local/' + encodeURIComponent('C:\\Users\\me\\projects\\diff-comments-to-md'))).toBe('diff-comments-to-md');
    expect(titleOf('#/local/' + encodeURIComponent('/home/me/projects/diff-comments-to-md'))).toBe('diff-comments-to-md');
  });

  it('вид внутри репозитория заголовка не меняет: это один и тот же репозиторий', () => {
    const root = encodeURIComponent('/home/me/projects/app');
    expect(titleOf(`#/local/${root}?mode=commits&from=aaa&to=bbb&file=src/App.tsx`)).toBe('app');
  });

  it('PR подписан своим репозиторием и номером', () => {
    expect(titleOf('#/pr/github.com/shhhwepsss/diff-comments-to-md/30')).toBe('shhhwepsss/diff-comments-to-md #30');
  });

  it('пока ничего не открыто — название инструмента', () => {
    expect(titleOf('#/local')).toBe(PRODUCT_NAME);
    expect(titleOf('#/pr')).toBe(PRODUCT_NAME);
    expect(titleOf('#/settings')).toBe(PRODUCT_NAME);
    expect(titleOf('')).toBe(PRODUCT_NAME);
  });

  it('настройки открыты поверх репозитория, но репозиторий не на экране', () => {
    const back = encodeURIComponent('#/local/' + encodeURIComponent('/home/me/app'));
    expect(titleOf(`#/settings/${back}`)).toBe(PRODUCT_NAME);
  });

  it('корень без хвостового разделителя и с ним — одно имя', () => {
    expect(repoName('/home/me/app/')).toBe('app');
    expect(repoName('C:\\projects\\app\\')).toBe('app');
  });

  it('корень без разделителей остаётся собой', () => {
    expect(repoName('app')).toBe('app');
  });
});
