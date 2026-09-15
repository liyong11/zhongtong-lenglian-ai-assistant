/**
 * 钉钉登录 API 封装（移植自 houpe-auth/dingtalk.js，axios 改为 Node 内置 fetch）
 *
 * 两条登录路径：
 *  A. PC 浏览器扫码：getQrConnectUrl 生成跳转地址 → 用户扫码 → getUserByCode 用 code 换用户信息
 *     （OAuth2 v1.0：userAccessToken + contact/users/me，再借 unionId 换企业内真实姓名/手机号）
 *  B. 钉钉客户端内免登：前端 dd.runtime.permission.requestAuthCode 拿 authCode → getUserByAuthCode
 *     （topapi：gettoken → v2/user/getuserinfo → v2/user/get）
 *
 * 凭据由调用方按次传入（本项目存 config.json，非环境变量）；access_token 按 appKey 缓存。
 */
let tokenCache = { key: '', token: null, expires: 0 };

async function getAccessToken(appKey, appSecret) {
  const now = Date.now();
  if (tokenCache.key === appKey && tokenCache.token && tokenCache.expires > now) return tokenCache.token;

  const resp = await fetch(`https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`);
  const data = await resp.json();
  if (data.errcode !== 0) throw new Error(`gettoken failed: ${data.errmsg}`);
  tokenCache = { key: appKey, token: data.access_token, expires: now + (data.expires_in - 300) * 1000 };
  return data.access_token;
}

// 钉钉客户端内免登：authCode 换用户详情
async function getUserByAuthCode(authCode, appKey, appSecret) {
  const token = await getAccessToken(appKey, appSecret);

  const infoResp = await fetch(`https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: authCode }),
  });
  const infoRes = await infoResp.json();
  if (infoRes.errcode !== 0) throw new Error(`getuserinfo failed: ${infoRes.errmsg}`);

  const userid = infoRes.result.userid;

  const userResp = await fetch(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userid }),
  });
  const userRes = await userResp.json();
  if (userRes.errcode !== 0) throw new Error(`user/get failed: ${userRes.errmsg}`);

  const u = userRes.result;
  return { userId: u.userid, name: u.name, avatar: u.avatar, mobile: u.mobile || '', unionId: u.unionid };
}

// PC 扫码登录地址（redirect_uri 必须已在钉钉开放平台配置为授权回调地址）
function getQrConnectUrl(redirectUri, state, appKey) {
  return `https://login.dingtalk.com/oauth2/auth?redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${appKey}&response_type=code&scope=openid&state=${state}&prompt=consent`;
}

function normalizeError(err) {
  const msg = (err.response && err.response.data && err.response.data.message) || err.message || '';
  if (msg.includes('AccessTokenPermissionDenied')) return '无权限访问钉钉应用';
  if (msg.includes('invalid code')) return '授权码已过期';
  return msg || '钉钉接口错误';
}

// 扫码回调：code 换用户信息（v1.0 接口 + unionId 回查企业通讯录）
async function getUserByCode(code, appKey, appSecret) {
  const tokenResp = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: appKey, clientSecret: appSecret, code, grantType: 'authorization_code' }),
  });
  const tokenRes = await tokenResp.json();
  if (tokenRes.message) throw new Error(normalizeError({ response: { data: tokenRes } }));

  const accessToken = tokenRes.accessToken;

  const meResp = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
    headers: { 'x-acs-dingtalk-access-token': accessToken },
  });
  const userRes = await meResp.json();

  const unionId = userRes.unionId || '';
  let realName = userRes.nickName || userRes.mobile || '未知用户';
  let mobile = userRes.mobile || '';

  if (unionId) {
    try {
      const corpToken = await getAccessToken(appKey, appSecret);
      const unionResp = await fetch(`https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(corpToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unionid: unionId }),
      });
      const unionRes = await unionResp.json();
      if (unionRes.errcode === 0 && unionRes.result && unionRes.result.userid) {
        const userid = unionRes.result.userid;
        const detailResp = await fetch(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(corpToken)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userid }),
        });
        const detailRes = await detailResp.json();
        if (detailRes.errcode === 0) {
          realName = detailRes.result.name || realName;
          mobile = detailRes.result.mobile || mobile;
        }
      }
    } catch (err) {
      console.error('[dingtalk] getbyunionid error:', err.message);
    }
  }

  return {
    userId: userRes.openId || unionId,
    name: realName,
    avatar: userRes.avatarUrl || '',
    mobile: mobile,
    unionId: unionId,
  };
}

module.exports = { getAccessToken, getUserByAuthCode, getQrConnectUrl, getUserByCode };
