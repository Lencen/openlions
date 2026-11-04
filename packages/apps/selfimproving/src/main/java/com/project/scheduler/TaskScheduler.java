package com.project.scheduler;

import java.util.List;
import java.util.ArrayList;

public class TaskScheduler {
    
    // 其他代码...
    
    /**
     * 更新任务状态
     * @param task 任务对象
     * @param newStatus 新状态
     * @param blockedReason 阻塞原因（当状态为BLOCKED时使用）
     */
    public void updateTaskStatus(Task task, TaskStatus newStatus, String blockedReason) {
        TaskStatus oldStatus = task.getStatus();
        task.setStatus(newStatus);
        
        // 修复：当标记任务为BLOCKED时，同时将阻塞原因写入blocks字段
        if (newStatus == TaskStatus.BLOCKED && blockedReason != null) {
            List<String> blocks = task.getBlocks();
            if (blocks == null) {
                blocks = new ArrayList<>();
                task.setBlocks(blocks);
            }
            blocks.add(blockedReason);
        }
        
        // 保存任务更新
        taskRepository.save(task);
    }
    
    // 其他方法...
}