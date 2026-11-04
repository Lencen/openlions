/**
 * 明道云API客户端
 * 对接 https://cooperation.uniontech.com
 */


interface MingdaoConfig {
  appKey: string;
  secretKey: string;
  authSign: string;
  apiBase: string;
}

export class MingdaoClient {
  private appKey: string;
  private secretKey: string;
  private authSign: string;
  private apiBase: string;

  constructor(config?: Partial<MingdaoConfig>) {
    this.appKey = config?.appKey || process.env.MINGDAO_APP_KEY || "b60f546eb5203d01";
    this.secretKey = config?.secretKey || process.env.MINGDAO_SECRET_KEY || "d52T2GbMaeec5a4ZeY7B1u2c4f5Ifw9K5s3L2Mbydb0ve8fScG4Xcg609If5227d";
    this.authSign = config?.authSign || process.env.MINGDAO_AUTH_SIGN || "ODc5NDgwNTljNTk1MDNiZTBlYjNjMDZlYjIzMTAxN2I2MjMwMmZmMzEwMjIxZTgyOWM3MTg5YjcxMzNiNmRiYw==";
    this.apiBase = config?.apiBase || process.env.MINGDAO_API_BASE || "https://cooperation.uniontech.com/api/v2/open/worksheet";
  }

  private async _post(endpoint: string, data: Record<string, any>): Promise<any> {
    const url = `${this.apiBase}/${endpoint}`;
    const payload = {
      appKey: this.appKey,
      sign: this.authSign,
      ...data
    };
    const headers = {
      "Content-Type": "application/json",
      "Authorization": this.authSign
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    return response.json();
  }

  async get_rows(worksheetId: string, viewId: string = "", pageSize: number = 100, pageIndex: number = 1): Promise<any> {
    return this._post("getFilterRows", {
      worksheetId,
      viewId,
      pageSize,
      pageIndex,
      listType: 1
    });
  }

  async add_row(worksheetId: string, controls: Array<{controlId: string; value: any}>, triggerWorkflow: boolean = false): Promise<any> {
    return this._post("addRow", {
      worksheetId,
      triggerWorkflow,
      controls
    });
  }

  async update_row(worksheetId: string, rowId: string, controls: Array<{controlId: string; value: any}>): Promise<any> {
    return this._post("editRow", {
      worksheetId,
      rowId,
      triggerWorkflow: false,
      controls
    });
  }

  async get_row(worksheetId: string, rowId: string): Promise<any> {
    return this._post("getRowByIdPost", {
      worksheetId,
      rowId
    });
  }

  async delete_row(worksheetId: string, rowId: string): Promise<any> {
    return this._post("deleteRow", {
      worksheetId,
      rowId
    });
  }
}

// 导出默认配置的工作表ID
export const MINGDAO_WORKSHEETS = {
  PR: "6310a945cf6b81729de36aef",  // 产品需求管理PR
  CR: "6204a57a2b0648de31346429"   // 客户需求管理CR
};

export const MINGDAO_FIELDS = {
  PR_NAME: "6310a945cf6b81729de36af4",      // 产品需求名称
  PR_PRODUCT: "63174fc15f15ee49f6206f2b",    // 对应产品
  PR_DESC: "6315f4815f15ee49f6205f46",      // 需求描述
  PR_TYPE: "6310a945cf6b81729de36b03",      // 需求类型
  PR_STATUS: "6358d7a8490500951add65a8",     // 需求状态
  PR_PRIORITY: "68c292907a203d19357fc273",  // 优先级
};

export const MINGDAO_VIEWS = {
  PR_ALL: "6310a945cf6b81729de36b08",  // 全部视图
};