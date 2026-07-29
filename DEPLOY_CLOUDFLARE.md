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
    supply-profile.js
    rtms.js
  _shared/
    molit.js
    supply-area.js
    supply-store.js
```

브라우저는 배포 환경에서 국토부 API를 직접 호출하지 않고 아래 경로를 호출합니다.

```text
/api/apt-list
/api/apt-basis
/api/building-ledger
/api/supply-profile
/api/rtms
```

Cloudflare Pages Functions가 `MOLIT_SERVICE_KEY` secret을 사용해 국토부 API를 대신 호출합니다.

## 사용자가 준비할 것

1. GitHub 계정
2. Cloudflare 계정
3. Cloudflare Pages 프로젝트
4. 카카오 Developers JavaScript SDK 도메인 추가
5. Cloudflare Pages secret 등록
6. Cloudflare D1 데이터베이스와 `SUPPLY_DB` 바인딩

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

## 공급면적 공용 저장소

`/api/supply-profile`은 D1 바인딩 이름 `SUPPLY_DB`를 사용합니다.

```text
Workers & Pages
→ apt-price-viewer
→ Settings
→ Bindings
→ Add
→ D1 database
→ Variable name: SUPPLY_DB
```

테이블 정의는 `migrations/0001_supply_profile_cache.sql`에 있습니다. 함수도 최초
요청에서 동일한 테이블이 없으면 자동 생성합니다. Preview에 D1이 아직 연결되지
않은 경우 RC는 엣지 캐시로 시험 동작하지만, 영구 공용 저장 검증에는 D1이 필요합니다.

Preview와 Production은 바인딩이 서로 분리되어 있습니다. RC 시험 주소에서는
`Choose Environment: Preview`를 선택한 상태에서 `SUPPLY_DB`를 연결해야 합니다.
배포 후 아래 주소를 열어 저장소 상태를 확인합니다.

```text
https://<Preview 주소>/api/debug-env
```

정상적인 D1 연결 응답에는 아래 값이 포함됩니다.

```json
{
  "hasSupplyDb": true,
  "supplyStorage": "d1"
}
```

`hasSupplyDb`가 `false`이면 해당 배포는 영구 D1이 아니라 엣지 캐시를 사용합니다.
바인딩을 추가하거나 변경한 뒤에는 새 커밋을 배포하거나 기존 Preview 배포를 다시
시도해야 새 Functions 인스턴스에 바인딩이 적용됩니다.

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

- 팀 공용 관심단지 DB 저장
- Cloudflare Access 접근제어 설정

## 로컬 실행

기존 방식:

```text
start-localhost-8080.cmd
http://localhost:8080
```

로컬 Python 서버에서는 Pages Functions가 실행되지 않으므로 국토부 API는 기존처럼 설정 메뉴에 저장된 국토부 키를 사용합니다.

공급면적 계산, Pages Functions, 로컬 D1까지 함께 시험하려면:

```text
start-rc-local.cmd
http://127.0.0.1:8080/?apiProxy=1
```
