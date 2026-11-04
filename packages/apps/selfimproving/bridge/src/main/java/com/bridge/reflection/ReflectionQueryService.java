将查询条件从 RESOLVED 改为 OPEN:

原代码:
queryParams.put("status", "RESOLVED");

修改为:
queryParams.put("status", "OPEN");

或者如果使用枚举:
queryParams.put("status", ReflectionStatus.OPEN.name());