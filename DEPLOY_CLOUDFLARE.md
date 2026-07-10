# Cloudflare 배포 준비 메모

이 폴더는 Cloudflare Pages + Pages Functions 배포를 기준으로 정리되어 있습니다.

## 구조

```text
index.html
styles.css
app.js
functions/
  api/
    apt-list.js
    apt-basis.js
    building-ledger.js
    rtms.js
  _shared/
    molit.js
```

브라우저는 배포 환경에서 국토부 API를 직접 호출하지 않고 아래 경로를 호출합니다.

```text
/api/apt-list
/api/apt-basis
/api/building-ledger
/api/rtms
```

Cloudflare Pages Functions가 `MOLIT_SERVICE_KEY` secret을 사용해 국토부 API를 대신 호출합니다.

## 사용자가 준비할 것

1. GitHub 계정
2. Cloudflare 계정
3. Cloudflare Pages 프로젝트
4. 카카오 Developers JavaScript SDK 도메인 추가
5. Cloudflare Pages secret 등록

## Cloudflare Secret

국토부 일반 인증키는 코드에 넣지 말고 Cloudflare secret으로 등록합니다.

Cloudflare 대시보드에서 등록합니다.

```text
Settings
→ Variables and secrets
→ Production
→ Add
→ Type: Secret
→ Name: MOLIT_SERVICE_KEY
→ Value: 공공데이터포털에서 발급받은 국토부 일반 인증키
```

Preview 환경은 테스트 배포용입니다. 실제 `https://apt-price-viewer.pages.dev` 주소에는
Production 설정이 적용됩니다.

## Cloudflare Build 설정

`wrangler.toml`은 이 프로젝트에서 사용하지 않습니다. Pages 설정은 Cloudflare
대시보드에서 관리합니다.

```text
Framework preset: None
Build command: 비움
Build output directory: .
Root directory: 비움 또는 기본값
```

## 카카오 도메인 설정

카카오 Developers 콘솔에서 JavaScript SDK 도메인에 배포 주소를 추가해야 합니다.

예:

```text
http://localhost:8080
https://apt-price-viewer.pages.dev
```

프로젝트명이 달라지면 실제 Pages URL에 맞춰 등록합니다.

## 1차 배포 범위

이번 구조에서 완료된 것:

- 국토부 API 키를 브라우저 코드에서 제거
- Cloudflare Pages Functions로 국토부 API 프록시 추가
- 배포 환경에서는 `/api/...` 경로 사용
- localhost에서는 기존처럼 설정 메뉴의 국토부 키를 사용해 직접 호출

아직 다음 단계로 남겨둔 것:

- Cloudflare D1 캐시 저장
- 팀 공용 관심단지 DB 저장
- Cloudflare Access 접근제어 설정

## 로컬 실행

기존 방식:

```text
start-localhost-8080.cmd
http://localhost:8080
```

로컬 Python 서버에서는 Pages Functions가 실행되지 않으므로 국토부 API는 기존처럼 설정 메뉴에 저장된 국토부 키를 사용합니다.

Cloudflare Functions까지 로컬에서 테스트하려면 나중에 Wrangler 개발 서버를 사용합니다.
