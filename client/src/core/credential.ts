/**
 * vCenter 登录凭据（玩家通过 UIManager 输入后传递给扫描阶段）
 */
export interface VCenterCredential {
  host: string;
  port: number;
  username: string;
  password: string;
}
